package dev.larattalabs.architect.library;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Reason;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import net.minecraft.SharedConstants;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.resources.Identifier;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * Sponge schematic import and export with the game's registries and data fixers (docs/CONTRACT.md "Phase 6c slice SCH"; the
 * file format is {@link Schematic}). Import: read, upgrade to this game's DataVersion with vanilla's {@code STRUCTURE} fixer
 * (block states and block-entity data), check the block names, then stage a structure {@code .nbt} for the helper's
 * {@code import-schem} job. Export: a template (an entry) or a captured world box (a site) as a version-3 file.
 */
public final class Schematics {
	/** The folder for structures staged for the helper ({@code <gameDir>/architect/schem-staging/<n>/}); emptied as jobs end. */
	public static final String STAGING = "schem-staging";
	public static final String EXT_KEY = "architect_mc:schem";
	public static final String UNKNOWN_AS = "architect_mc:unknownAs";
	public static final String AUTHOR = "Architect";

	private Schematics() {
	}

	public static int currentDataVersion() {
		return SharedConstants.getCurrentVersion().dataVersion().version();
	}

	/** A block id this game knows. */
	public static boolean knownBlock(String name) {
		Identifier id = Identifier.tryParse(name);
		return id != null && BuiltInRegistries.BLOCK.containsKey(id);
	}

	/**
	 * A schematic made ready for the helper.
	 *
	 * @param structure the upgraded structure template tag (this game's DataVersion)
	 * @param ext the entry's ext: the request's (but {@code unknownAs}) plus {@code architect_mc:schem}
	 * @param notes what was skipped or replaced (for the log and the job's step)
	 */
	public record Prepared(Schematic.Parsed parsed, CompoundTag structure, String name, int groundY, JsonObject ext, List<String> notes) {
	}

	/**
	 * Reads, upgrades and checks a schematic. Every refusal comes before anything is written. {@code ext}: the request's
	 * (namespaced keys; {@code architect_mc:unknownAs} names a replacement block for unknown ones).
	 */
	public static Prepared prepare(byte[] bytes, String fileName, @Nullable String name, @Nullable JsonObject ext) throws Schematic.Refused {
		int current = currentDataVersion();
		Schematic.Parsed p = Schematic.read(bytes, current);
		CompoundTag structure = Schematic.toStructure(p);
		if (structure.getListOrEmpty("blocks").isEmpty()) {
			throw new Schematic.Refused(Reason.FORMAT, "every cell is structure_void: nothing to import");
		}
		try {
			structure = DataFixTypes.STRUCTURE.updateToCurrentVersion(DataFixers.getDataFixer(), structure, p.dataVersion());
		} catch (RuntimeException e) {
			throw new Schematic.Refused(Reason.FORMAT, "the data fixers could not upgrade it from DataVersion " + p.dataVersion() + " (" + e.getMessage()
				+ ")");
		}
		NbtUtils.addCurrentDataVersion(structure);
		List<String> notes = new ArrayList<>();
		String unknownAs = null;
		if (ext != null && ext.has(UNKNOWN_AS)) {
			JsonElement u = ext.get(UNKNOWN_AS);
			unknownAs = u != null && u.isJsonPrimitive() ? Schematic.namespaced(u.getAsString()) : null;
			if (unknownAs == null || !knownBlock(unknownAs)) {
				throw new Schematic.Refused(Reason.FORMAT, UNKNOWN_AS + " must name a block of this game (got " + u + ")");
			}
		}
		List<String> replaced = List.of();
		Predicate<String> known = Schematics::knownBlock;
		List<String> unknown = Schematic.unknownNames(structure, known);
		if (!unknown.isEmpty()) {
			if (unknownAs == null) {
				throw new Schematic.Refused(Reason.FORMAT, "blocks this game does not know (" + unknown.size() + "): " + String.join(", ", unknown)
					+ "; set ext " + UNKNOWN_AS + " to a block to replace them");
			}
			replaced = Schematic.replaceUnknown(structure, known, unknownAs);
			notes.add(replaced.size() + " unknown block(s) replaced by " + unknownAs + ": " + String.join(", ", replaced));
		}
		// block-entity data of a type this game lacks is dropped (the block keeps its default)
		ListTag blocks = structure.getListOrEmpty("blocks");
		int dropped = 0;
		for (int i = 0; i < blocks.size(); i++) {
			CompoundTag b = blocks.getCompoundOrEmpty(i);
			if (b.get("nbt") instanceof CompoundTag nbt) {
				Identifier id = Identifier.tryParse(nbt.getStringOr("id", ""));
				if (id == null || !BuiltInRegistries.BLOCK_ENTITY_TYPE.containsKey(id)) {
					b.remove("nbt");
					dropped++;
				}
			}
		}
		if (dropped > 0) {
			notes.add(dropped + " block entit" + (dropped == 1 ? "y" : "ies") + " of an unknown type dropped");
		}
		if (p.entities() > 0) {
			notes.add(p.entities() + " entit" + (p.entities() == 1 ? "y" : "ies") + " skipped (Architect places blocks only)");
		}
		if (p.biomes()) {
			notes.add("biomes ignored");
		}
		JsonObject out = new JsonObject();
		if (ext != null) {
			for (var e : ext.entrySet()) {
				if (!e.getKey().equals(UNKNOWN_AS) && !e.getKey().equals(EXT_KEY)) {
					out.add(e.getKey(), e.getValue().deepCopy());
				}
			}
		}
		JsonObject schem = new JsonObject();
		schem.addProperty("file", fileName);
		if (p.name() != null) {
			schem.addProperty("name", p.name());
		}
		if (p.author() != null) {
			schem.addProperty("author", p.author());
		}
		if (p.date() != null) {
			schem.addProperty("date", p.date());
		}
		schem.addProperty("version", p.version());
		schem.addProperty("dataVersion", p.dataVersion());
		JsonArray off = new JsonArray();
		for (int v : p.offset()) {
			off.add(v);
		}
		schem.add("offset", off);
		if (p.entities() > 0) {
			schem.addProperty("entitiesSkipped", p.entities());
		}
		if (!replaced.isEmpty()) {
			JsonArray r = new JsonArray();
			replaced.forEach(r::add);
			schem.add("replaced", r);
			schem.addProperty("unknownAs", unknownAs);
		}
		out.add(EXT_KEY, schem);
		String shown = name != null && !name.isBlank() ? name.strip() : p.name() != null && !p.name().isBlank() ? p.name().strip() : nameFromFile(fileName);
		if (shown.length() > 40) {
			shown = shown.substring(0, 40).strip();
		}
		return new Prepared(p, structure, shown, p.groundY(1), out, List.copyOf(notes));
	}

	/** A staged schematic and the {@code import.request} that hands it to the helper. */
	public record Staged(Path file, JsonObject message, Prepared prepared) {
	}

	/**
	 * Reads, upgrades and checks a schematic file, then stages it: the API's and the Library screen's shared path. Refusals
	 * ({@link Schematic.Refused}) come before anything is written.
	 */
	public static Staged stageImport(Path gameData, Path file, @Nullable String name, @Nullable JsonObject ext) throws Schematic.Refused, IOException {
		String fileName = file.getFileName().toString();
		if (!Files.isRegularFile(file)) {
			throw new java.nio.file.NoSuchFileException(file.toString());
		}
		long size = Files.size(file);
		if (size > Schematic.MAX_FILE_BYTES) {
			throw new Schematic.Refused(Reason.TOO_LARGE, size + " bytes is more than the " + Schematic.MAX_FILE_BYTES + " a schematic file may have");
		}
		Prepared prep = prepare(Files.readAllBytes(file), fileName, name, ext);
		Path out = stage(gameData, fileName, prep.structure());
		JsonObject m = new JsonObject();
		m.addProperty("type", "import.request");
		m.addProperty("path", out.toAbsolutePath().toString());
		m.addProperty("name", prep.name());
		JsonObject schem = new JsonObject();
		schem.addProperty("file", fileName.length() > 255 ? fileName.substring(0, 255) : fileName);
		schem.addProperty("groundY", prep.groundY());
		schem.add("ext", prep.ext());
		m.add("schem", schem);
		return new Staged(out, m, prep);
	}

	/** A staged file of {@code gameData}'s staging folder (the only ones {@link #unstage} removes). */
	public static boolean isStaged(Path gameData, Path p) {
		Path root = gameData.resolve(STAGING).toAbsolutePath().normalize();
		Path f = p.toAbsolutePath().normalize();
		return f.startsWith(root) && !f.equals(root);
	}

	/** "my_old-house v2.schem" -> "My Old House V2" (as the kit's importer names a file). */
	public static String nameFromFile(String file) {
		String base = file.replaceAll("^.*[\\\\/]", "").replaceAll("(?i)\\.(schem|nbt)$", "");
		StringBuilder sb = new StringBuilder();
		for (String w : base.replaceAll("[^A-Za-z0-9]+", " ").strip().split("\\s+")) {
			if (!w.isEmpty()) {
				sb.append(sb.isEmpty() ? "" : " ").append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
			}
		}
		String s = sb.length() > 40 ? sb.substring(0, 40).strip() : sb.toString();
		return s.isEmpty() ? "Imported Schematic" : s;
	}

	/** The file stem as a staged file name ({@code [a-z0-9_]}, at most 32). */
	static String slug(String file) {
		String base = file.replaceAll("^.*[\\\\/]", "").replaceAll("(?i)\\.(schem|nbt)$", "").toLowerCase(Locale.ROOT)
			.replaceAll("[^a-z0-9]+", "_").replaceAll("^_+|_+$", "");
		if (base.length() > 32) {
			base = base.substring(0, 32);
		}
		return base.isEmpty() ? "schematic" : base;
	}

	/** Writes the structure to a fresh {@code <gameData>/schem-staging/<n>/<stem>.nbt}. */
	public static Path stage(Path gameData, String fileName, CompoundTag structure) throws IOException {
		Path root = gameData.resolve(STAGING);
		Files.createDirectories(root);
		Path dir = Files.createTempDirectory(root, "s");
		Path out = dir.resolve(slug(fileName) + ".nbt");
		NbtIo.writeCompressed(structure, out);
		return out;
	}

	/** Removes a staged file and its folder (quietly). */
	public static void unstage(@Nullable Path staged) {
		if (staged == null) {
			return;
		}
		try {
			Files.deleteIfExists(staged);
			Files.deleteIfExists(staged.getParent());
		} catch (IOException ignored) {
			// a leftover staging folder is harmless
		}
	}

	// ------------------------------------------------------------------ export

	/** A block state as a palette string ({@code ns:name[k=v,...]}, the block's own property order). */
	public static String stateString(BlockState s) {
		return BlockStateParser.serialize(s);
	}

	/**
	 * A structure template tag (an entry's, or a captured box) as version-3 bytes. Cells the template does not write (and its
	 * own {@code structure_void}) are {@code structure_void}.
	 */
	public static byte[] encode(CompoundTag template, String name, long date, int groundY) {
		ListTag size = template.getListOrEmpty("size");
		int w = size.getIntOr(0, 0);
		int h = size.getIntOr(1, 0);
		int l = size.getIntOr(2, 0);
		ListTag paletteTag = template.getListOrEmpty("palette");
		if (paletteTag.isEmpty()) {
			paletteTag = template.getListOrEmpty("palettes").getListOrEmpty(0);
		}
		String[] palette = new String[paletteTag.size()];
		BlockState[] states = new BlockState[paletteTag.size()];
		for (int i = 0; i < palette.length; i++) {
			states[i] = NbtUtils.readBlockState(BuiltInRegistries.BLOCK, paletteTag.getCompoundOrEmpty(i));
			palette[i] = stateString(states[i]);
		}
		String[] grid = new String[w * h * l];
		List<Schematic.BlockEntity> bes = new ArrayList<>();
		ListTag blocks = template.getListOrEmpty("blocks");
		for (int i = 0; i < blocks.size(); i++) {
			CompoundTag b = blocks.getCompoundOrEmpty(i);
			ListTag pos = b.getListOrEmpty("pos");
			int x = pos.getIntOr(0, -1);
			int y = pos.getIntOr(1, -1);
			int z = pos.getIntOr(2, -1);
			int si = b.getIntOr("state", -1);
			if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= l || si < 0 || si >= palette.length) {
				continue;
			}
			String st = palette[si];
			grid[x + z * w + y * w * l] = Schematic.STRUCTURE_VOID.equals(st) ? null : st;
			if (st != null && !Schematic.STRUCTURE_VOID.equals(st) && b.get("nbt") instanceof CompoundTag nbt) {
				String id = nbt.getStringOr("id", "");
				if (id.isEmpty() && states[si].hasBlockEntity()) {
					var type = BuiltInRegistries.BLOCK_ENTITY_TYPE.stream().filter(t -> t.isValid(states[si])).findFirst().orElse(null);
					id = type == null ? "" : String.valueOf(BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(type));
				}
				if (!id.isEmpty()) {
					bes.add(new Schematic.BlockEntity(x, y, z, id, nbt));
				}
			}
		}
		CompoundTag root = Schematic.write(w, h, l, (x, y, z) -> grid[x + z * w + y * w * l], bes,
			new Schematic.Meta(name, AUTHOR, date, currentDataVersion(), groundY));
		return Schematic.gzip(root);
	}

	/** The file name an export writes ({@code <id>.schem}, {@code <id>-v<n>.schem} for an older version). */
	public static String exportName(String id, @Nullable Integer version, boolean head) {
		return id + (version == null || head ? "" : "-v" + version) + ".schem";
	}

	/** Writes bytes atomically ({@code .tmp} then move). */
	public static Path write(Path dir, String fileName, byte[] bytes) throws IOException {
		Files.createDirectories(dir);
		Path out = dir.resolve(fileName);
		Path tmp = dir.resolve(fileName + ".tmp");
		Files.write(tmp, bytes);
		Files.move(tmp, out, java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
		return out;
	}

	/** A site box's min corner. */
	public static BlockPos min(BoundingBox box) {
		return new BlockPos(box.minX(), box.minY(), box.minZ());
	}

	/** A template's structure tag (the first palette of a random-palette template). */
	public static CompoundTag templateTag(StructureTemplate t) {
		return t.save(new CompoundTag());
	}
}
