package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Reason;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 6c SCH (docs/CONTRACT.md "Phase 6c slice SCH" §5): the mod's reader on the kit's spec fixtures
 * ({@code kit/test/fixtures/schem/}), the upgrade of an old DataVersion through vanilla's data fixers, the refusals, and the
 * version-3 export of every kit example (round trip, two exports byte-identical, the committed sha256 that CI's Linux run
 * reproduces).
 */
class SchematicTest {
	static final Path FIX = Path.of("..", "kit", "test", "fixtures", "schem");
	static final Path EXAMPLES = Path.of("..", "kit", "examples");

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static byte[] fixture(String name) throws Exception {
		return Files.readAllBytes(FIX.resolve(name));
	}

	/** Every written cell of a structure tag: "x,y,z" -> the state string (+ the block entity's data, id included). */
	static Map<String, String> cells(CompoundTag structure) {
		ListTag pal = structure.getListOrEmpty("palette");
		String[] states = new String[pal.size()];
		for (int i = 0; i < states.length; i++) {
			states[i] = Schematics.stateString(NbtUtils.readBlockState(BuiltInRegistries.BLOCK, pal.getCompoundOrEmpty(i)));
		}
		Map<String, String> out = new TreeMap<>();
		ListTag blocks = structure.getListOrEmpty("blocks");
		for (int i = 0; i < blocks.size(); i++) {
			CompoundTag b = blocks.getCompoundOrEmpty(i);
			String st = states[b.getIntOr("state", -1)];
			if (st.equals(Schematic.STRUCTURE_VOID)) {
				continue;
			}
			ListTag pos = b.getListOrEmpty("pos");
			out.put(pos.getIntOr(0, 0) + "," + pos.getIntOr(1, 0) + "," + pos.getIntOr(2, 0), st + (b.get("nbt") instanceof CompoundTag n ? " " + n : ""));
		}
		return out;
	}

	static String sha(byte[] b) throws Exception {
		return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
	}

	@Test
	void v2AndV3ReadAlike() throws Exception {
		int cur = Schematics.currentDataVersion();
		Schematic.Parsed v3 = Schematic.read(fixture("v3_hut.schem"), cur);
		Schematic.Parsed v2 = Schematic.read(fixture("v2_hut.schem"), cur);
		assertEquals(3, v3.version());
		assertEquals(2, v2.version());
		assertEquals(1, v3.entities());
		assertTrue(v3.biomes());
		assertEquals("Spec Hut v3", v3.name());
		assertEquals(1, v3.groundY(1), "-Offset.y");
		assertEquals(1, v2.groundY(1));
		Map<String, String> a = cells(Schematic.toStructure(v3));
		assertEquals(96, a.size(), "the structure_void column is not written");
		assertEquals(a, cells(Schematic.toStructure(v2)));
		assertTrue(a.get("1,1,1").startsWith("minecraft:chest[") && a.get("1,1,1").contains("minecraft:bread"), a.get("1,1,1"));
		assertTrue(a.get("3,1,1").contains("front_text"), a.get("3,1,1"));
	}

	@Test
	void prepareKeepsNamesAndExt() throws Exception {
		Schematics.Prepared p = Schematics.prepare(fixture("v3_hut.schem"), "v3_hut.schem", null, null);
		assertEquals("Spec Hut v3", p.name());
		assertEquals(1, p.groundY());
		JsonObject schem = p.ext().getAsJsonObject(Schematics.EXT_KEY);
		assertEquals("Spec Hut v3", schem.get("name").getAsString());
		assertEquals("spec fixture", schem.get("author").getAsString());
		assertEquals(3, schem.get("version").getAsInt());
		assertEquals(1, schem.get("entitiesSkipped").getAsInt());
		assertTrue(p.notes().stream().anyMatch(n -> n.contains("1 entity skipped")), p.notes().toString());
		assertEquals(Schematics.currentDataVersion(), NbtUtils.getDataVersion(p.structure(), 0));
		JsonObject req = JsonParser.parseString("{\"steward_mc:lot\":\"L1\"}").getAsJsonObject();
		assertEquals("L1", Schematics.prepare(fixture("v2_hut.schem"), "v2_hut.schem", "Hut", req).ext().get("steward_mc:lot").getAsString());
	}

	@Test
	void oldDataVersionUpgrades() throws Exception {
		Schematics.Prepared p = Schematics.prepare(fixture("old_dataversion.schem"), "old_dataversion.schem", null, null);
		assertEquals(2586, p.parsed().dataVersion());
		List<String> unknown = Schematic.unknownNames(p.structure(), Schematics::knownBlock);
		assertEquals(List.of(), unknown, "0 unknown states after the fixers");
		Map<String, String> c = cells(p.structure());
		assertTrue(c.containsValue("minecraft:dirt_path"), c.toString());
		assertTrue(c.containsValue("minecraft:short_grass"), c.toString());
		assertFalse(c.values().stream().anyMatch(s -> s.startsWith("minecraft:grass_path") || s.equals("minecraft:grass")), c.toString());
		String sign = c.get("2,1,2");
		assertTrue(sign.contains("front_text") && sign.contains("Old") && !sign.contains("Text1"), sign);
		// before the fixers the 1.16.5 names are unknown here
		assertEquals(List.of("minecraft:grass", "minecraft:grass_path"), Schematic.unknownNames(Schematic.toStructure(Schematic.read(fixture(
			"old_dataversion.schem"), Schematics.currentDataVersion())), Schematics::knownBlock));
	}

	@Test
	void refusals() throws Exception {
		Schematic.Refused big = assertThrows(Schematic.Refused.class, () -> Schematics.prepare(fixture("oversize.schem"), "oversize.schem", null, null));
		assertEquals(Reason.TOO_LARGE, big.reason());
		Schematic.Refused bad = assertThrows(Schematic.Refused.class, () -> Schematics.prepare(fixture("corrupt.schem"), "corrupt.schem", null, null));
		assertEquals(Reason.FORMAT, bad.reason());
		assertTrue(bad.getMessage().contains("97 cells"), bad.getMessage());
		Schematic.Refused unk = assertThrows(Schematic.Refused.class, () -> Schematics.prepare(fixture("unknown_block.schem"), "unknown_block.schem", null,
			null));
		assertEquals(Reason.FORMAT, unk.reason());
		assertTrue(unk.getMessage().contains("othermod:gizmo") && unk.getMessage().contains("othermod:widget"), unk.getMessage());
		// a newer DataVersion, an unknown version, not a schematic, not NBT
		Schematic.Refused newer = assertThrows(Schematic.Refused.class, () -> Schematic.read(fixture("v3_hut.schem"), 4000));
		assertEquals(Reason.FORMAT, newer.reason());
		CompoundTag root = NbtIo.readCompressed(new ByteArrayInputStream(fixture("v3_hut.schem")), NbtAccounter.unlimitedHeap());
		root.getCompoundOrEmpty("Schematic").putInt("Version", 4);
		assertTrue(assertThrows(Schematic.Refused.class, () -> Schematic.read(root, 5023)).getMessage().contains("version 4"));
		CompoundTag structure = NbtIo.readCompressed(EXAMPLES.resolve("cabin").resolve("cabin.nbt"), NbtAccounter.unlimitedHeap());
		assertTrue(assertThrows(Schematic.Refused.class, () -> Schematic.read(structure, 5023)).getMessage().contains("not a Sponge schematic"));
		assertEquals(Reason.FORMAT, assertThrows(Schematic.Refused.class, () -> Schematic.read(new byte[] {0x1f, (byte) 0x8b, 8, 0, 1}, 5023)).reason());
	}

	@Test
	void unknownAsReplaces() throws Exception {
		JsonObject ext = JsonParser.parseString("{\"architect_mc:unknownAs\":\"minecraft:stone\"}").getAsJsonObject();
		Schematics.Prepared p = Schematics.prepare(fixture("unknown_block.schem"), "unknown_block.schem", null, ext);
		assertEquals(List.of(), Schematic.unknownNames(p.structure(), Schematics::knownBlock));
		JsonObject schem = p.ext().getAsJsonObject(Schematics.EXT_KEY);
		assertEquals(2, schem.getAsJsonArray("replaced").size());
		assertFalse(p.ext().has(Schematics.UNKNOWN_AS), "unknownAs is a request option, not stored");
		JsonObject bad = JsonParser.parseString("{\"architect_mc:unknownAs\":\"othermod:x\"}").getAsJsonObject();
		assertEquals(Reason.FORMAT, assertThrows(Schematic.Refused.class, () -> Schematics.prepare(fixture("unknown_block.schem"), "u.schem", null, bad))
			.reason());
	}

	@Test
	void exportRoundTripAndDeterminism() throws Exception {
		JsonObject goldens = JsonParser.parseString(Files.readString(FIX.resolve("goldens.json"))).getAsJsonObject();
		JsonObject mod = goldens.has("mod") ? goldens.getAsJsonObject("mod") : new JsonObject();
		List<String> examples;
		try (var s = Files.list(EXAMPLES)) {
			examples = s.map(p -> p.getFileName().toString()).filter(e -> Files.isRegularFile(EXAMPLES.resolve(e).resolve(e + ".nbt"))).sorted().toList();
		}
		assertTrue(examples.size() >= 4, examples.toString());
		JsonObject got = new JsonObject();
		for (String e : examples) {
			CompoundTag t = NbtIo.readCompressed(EXAMPLES.resolve(e).resolve(e + ".nbt"), NbtAccounter.unlimitedHeap());
			int groundY = JsonParser.parseString(Files.readString(EXAMPLES.resolve(e).resolve(e + ".blueprint.json"))).getAsJsonObject().get("groundY")
				.getAsInt();
			byte[] a = Schematics.encode(t, e, 0L, groundY);
			byte[] b = Schematics.encode(t.copy(), e, 0L, groundY);
			assertArrayEquals(a, b, e + ": two exports differ");
			Schematic.Parsed p = Schematic.read(a, Schematics.currentDataVersion());
			assertEquals(3, p.version());
			assertEquals(-groundY, p.offset()[1]);
			assertEquals("Architect", p.author());
			assertEquals(cells(t), cells(Schematic.toStructure(p)), e + ": the cells moved");
			got.addProperty(e, sha(a));
		}
		assertEquals(mod, got, "the exports' bytes moved (kit/test/fixtures/schem/goldens.json \"mod\"; macOS and CI's Linux must agree)");
		// the hut fixture's block entities survive an export and a read
		CompoundTag hut = Schematics.prepare(fixture("v3_hut.schem"), "v3_hut.schem", null, null).structure();
		byte[] out = Schematics.encode(hut, "hut", 1L, 1);
		assertEquals(cells(hut), cells(Schematic.toStructure(Schematic.read(out, Schematics.currentDataVersion()))));
	}
}
