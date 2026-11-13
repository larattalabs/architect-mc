package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import net.minecraft.SharedConstants;
import net.minecraft.core.component.DataComponentPatch;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.item.component.ItemContainerContents;
import net.minecraft.network.chat.Component;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Slice PS (docs/CONTRACT.md "Slice PS, ledger saves"):
 * <ul>
 * <li>F6: an unreadable {@code stockpiles.json} (bad JSON, a pile that fails midway) loads nothing and is never saved over; a good one is
 * kept as {@code stockpiles.json.bak};</li>
 * <li>F11: the file is written as format 2; format 1 reads (and is written back as 2), 2 reads, 3 is refused;</li>
 * <li>N2: a stack with components is never booked into a crate;</li>
 * <li>source guards for the paths that need a live server: the periodic save (F4 b), the refund credit's save (N1) and the queue file's
 * guard (F6).</li>
 * </ul>
 */
class StockpileSavePSTest {
	@TempDir
	Path tmp;

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@AfterEach
	void reset() {
		Stockpiles.loadFrom(tmp.resolve("none")); // a dir without a file: nothing loaded, the guard off
		SaveGuards.clear();
	}

	static final String PILE = """
		{"id":"sp1","owner":"test:a","dimension":"minecraft:overworld","crates":[],"ledger":{"delivered":{"minecraft:cobblestone":5}}}""";

	Path write(String json) throws Exception {
		Path f = tmp.resolve(Stockpiles.FILE);
		Files.writeString(f, json, StandardCharsets.UTF_8);
		return f;
	}

	JsonObject read(Path f) throws Exception {
		return JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	void assertRefusedAndKept(Path f, byte[] before, String why) throws Exception {
		assertTrue(Stockpiles.loadFailed(), "the load failed: " + why);
		assertTrue(Stockpiles.all().isEmpty(), "nothing loaded: " + why);
		assertTrue(SaveGuards.failures().containsKey(Stockpiles.FILE), "the status line names the file");
		Stockpiles.save(); // as BEFORE_SAVE, SERVER_STOPPING and saveWithWorld's ledger write would
		assertArrayEquals(before, Files.readAllBytes(f), "the file is kept as it is: " + why);
		assertFalse(Files.exists(tmp.resolve(Stockpiles.FILE + ".bak")), "no .bak of a file that didn't load");
	}

	@Test
	void anUnreadableFileIsNeverOverwritten() throws Exception {
		Path f = write("{\"format\":2,\"stockpiles\":[" + PILE + ",{\"owner\":"); // cut off midway
		byte[] before = Files.readAllBytes(f);
		Stockpiles.loadFrom(tmp);
		assertRefusedAndKept(f, before, "bad JSON");
	}

	@Test
	void aPileThatFailsMidwayFailsTheWholeFile() throws Exception {
		// the second pile's ledger is not an object: readInto throws after the first pile is in; nothing stays loaded
		Path f = write("{\"format\":2,\"nextId\":3,\"stockpiles\":[" + PILE
			+ ",{\"id\":\"sp2\",\"owner\":\"test:b\",\"dimension\":\"minecraft:overworld\",\"crates\":[],\"ledger\":7}]}");
		byte[] before = Files.readAllBytes(f);
		Stockpiles.loadFrom(tmp);
		assertRefusedAndKept(f, before, "a bad pile");
	}

	@Test
	void aNewerFormatIsRefused() throws Exception {
		Path f = write("{\"format\":3,\"nextId\":2,\"stockpiles\":[" + PILE + "]}");
		byte[] before = Files.readAllBytes(f);
		Stockpiles.loadFrom(tmp);
		assertRefusedAndKept(f, before, "format 3");
	}

	@Test
	void formatOneReadsAndIsWrittenBackAsTwo() throws Exception {
		Path f = write("{\"format\":1,\"nextId\":2,\"stockpiles\":[" + PILE + "]}");
		String original = Files.readString(f);
		Stockpiles.loadFrom(tmp);
		assertFalse(Stockpiles.loadFailed());
		assertNotNull(Stockpiles.get("test:a"));
		assertEquals(5, Stockpiles.get("test:a").ledger().stock("minecraft:cobblestone"));
		assertEquals(original, Files.readString(tmp.resolve(Stockpiles.FILE + ".bak")), "the file that loaded is kept as .bak (format 1, for a downgrade)");
		Stockpiles.save();
		JsonObject saved = read(f);
		assertEquals(2, saved.get("format").getAsInt(), "1 -> 2");
		assertEquals(5, saved.getAsJsonArray("stockpiles").get(0).getAsJsonObject().getAsJsonObject("ledger").getAsJsonObject("delivered")
			.get("minecraft:cobblestone").getAsInt());
	}

	@Test
	void formatTwoReadsAndStaysTwo() throws Exception {
		Path f = write("{\"format\":2,\"nextId\":2,\"stockpiles\":[" + PILE + "]}");
		Stockpiles.loadFrom(tmp);
		assertFalse(Stockpiles.loadFailed());
		assertEquals(5, Stockpiles.get("test:a").ledger().stock("minecraft:cobblestone"));
		Stockpiles.save();
		assertEquals(2, read(f).get("format").getAsInt(), "2 -> 2");
		Stockpiles.loadFrom(tmp);
		assertFalse(Stockpiles.loadFailed(), "the written file reads back");
		assertEquals(5, Stockpiles.get("test:a").ledger().stock("minecraft:cobblestone"));
	}

	@Test
	void stacksWithComponentsAreNeverBooked() {
		// (the unit tests have no bound item components, so no ItemStack: the patch a stack carries, as vanilla builds it)
		assertTrue(CrateBlockEntity.plainPatch(DataComponentPatch.EMPTY), "a plain stack (no patch) goes in");
		assertFalse(CrateBlockEntity.plainPatch(DataComponentPatch.builder().set(DataComponents.CUSTOM_NAME, Component.literal("mine")).build()),
			"a named stack is refused");
		assertFalse(CrateBlockEntity.plainPatch(DataComponentPatch.builder().set(DataComponents.DAMAGE, 5).build()), "a damaged tool is refused");
		assertFalse(CrateBlockEntity.plainPatch(DataComponentPatch.builder().set(DataComponents.CONTAINER, ItemContainerContents.EMPTY).build()),
			"a shulker box carrying a container component (filled, or emptied and still carrying it) is refused");
		assertFalse(CrateBlockEntity.plainPatch(DataComponentPatch.builder().remove(DataComponents.MAX_STACK_SIZE).build()), "a removed default counts too");
		// insert() refuses before any booking: a crate block entity without a level books nothing, but the plain check comes first
		String src;
		try {
			src = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/survival/CrateBlockEntity.java")).replaceAll("//[^\n]*", "");
		} catch (java.io.IOException e) {
			throw new AssertionError(e);
		}
		String ins = StockpileSaveHFTest.body(src, "public int insert(ItemStack stack)");
		assertTrue(ins.indexOf("!plain(stack)") >= 0 && ins.indexOf("!plain(stack)") < ins.indexOf("Builder.accepts"), "insert refuses before booking");
		assertTrue(StockpileSaveHFTest.body(src, "public boolean wouldAccept(ItemStack stack)").contains("plain(stack)"),
			"wouldAccept (hoppers', droppers' canPlaceItem) refuses too");
	}

	@Test
	void periodicSaveRefundSaveAndQueueGuard() throws Exception {
		String sp = StockpileSaveHFTest.src().replaceAll("//[^\n]*", "");
		assertEquals(200, Stockpiles.PERIODIC_TICKS, "F4 b: at most every 10 s");
		String tick = StockpileSaveHFTest.body(sp, "static void tick(MinecraftServer srv)");
		assertTrue(tick.contains("periodicSave(srv);"), "the tick runs the periodic save");
		String per = StockpileSaveHFTest.body(sp, "static void periodicSave(MinecraftServer srv)");
		assertTrue(per.contains("!unsaved") && per.contains("loadFailed") && per.contains("PERIODIC_TICKS") && per.contains("saveWithWorld(srv);"),
			"a changed ledger, a loaded file, 10 s since the last save: the full save (players, chunks, ledger)");
		String sww = StockpileSaveHFTest.body(sp, "static void saveWithWorld(MinecraftServer srv)");
		assertTrue(sww.indexOf("if (loadFailed)") >= 0 && sww.indexOf("if (loadFailed)") < sww.indexOf("saveAll()"), "saveWithWorld refuses first");
		String save = StockpileSaveHFTest.body(sp, "static void save()");
		assertTrue(save.contains("if (loadFailed)"), "save() refuses");

		String g = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Groups.java")).replaceAll("//[^\n]*", "");
		String credit = StockpileSaveHFTest.body(g, "private static void credit(MinecraftServer server, Removal r, String id)");
		int booked = credit.indexOf("Builder.creditRefund(");
		int saved = credit.indexOf("Stockpiles.saveWithWorld(server);");
		assertTrue(booked >= 0 && saved > booked, "N1: a booked refund credit is saved with the world right after it");
		assertTrue(credit.substring(booked, saved).contains("if (!already)"), "only when it booked (once per key)");

		String pl = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Placement.java")).replaceAll("//[^\n]*", "");
		String psave = StockpileSaveHFTest.body(pl, "static void save(MinecraftServer srv, boolean clean)");
		assertTrue(psave.indexOf("if (loadFailed)") >= 0 && psave.indexOf("if (loadFailed)") < psave.indexOf("PENDING_SAVE"), "the queue file: no save after a failed load");
		String pload = StockpileSaveHFTest.body(pl, "private static void load(MinecraftServer srv)");
		assertTrue(pload.contains("loadFailed = true;") && pload.contains("SaveGuards.failed(FILE") && pload.contains("FILE + \".bak\""),
			"the queue file: the guard, the status line and the .bak");
	}
}
