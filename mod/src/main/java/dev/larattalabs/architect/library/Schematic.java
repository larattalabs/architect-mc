package dev.larattalabs.architect.library;

import dev.larattalabs.architect.api.Reason;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutput;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.zip.GZIPOutputStream;
import net.minecraft.nbt.ByteArrayTag;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.IntArrayTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.Tag;
import org.jspecify.annotations.Nullable;

/**
 * Sponge Schematic files (docs/CONTRACT.md "Phase 6c slice SCH"): reading versions 2 and 3 into a vanilla structure template
 * tag, and writing version 3. Written from the public specification only, SpongePowered/Schematic-Specification at
 * 8e6be2d980d3bd794bc29df5fdca5921129fac5d, {@code versions/schematic-2.md} and {@code versions/schematic-3.md}; no other
 * implementation was consulted. Pure: NBT values in and out, no registries (the caller upgrades with vanilla's data fixers and
 * checks the block names against the game's registry).
 *
 * <p>What the spec says and this follows:
 * <ul>
 * <li>Version 3: the root compound holds one compound {@code Schematic} with {@code Version} 3, {@code DataVersion},
 * {@code Metadata}, {@code Width}/{@code Height}/{@code Length} (unsigned shorts), {@code Offset} (int[3]) and the block
 * container {@code Blocks}: {@code Palette} (state string to index), {@code Data} (varint[]: one palette index per cell,
 * indexed {@code x + z * Width + y * Width * Length}) and {@code BlockEntities} ({@code Pos} int[3], {@code Id}, {@code Data}).
 * {@code Biomes} and {@code Entities} are optional.</li>
 * <li>Version 2: the same fields directly in the root compound, with {@code Palette}, {@code PaletteMax}, {@code BlockData} and
 * {@code BlockEntities} whose type's own fields sit next to {@code Pos} and {@code Id} (the spec's "Extra"; a compound named
 * {@code Extra} is read too).</li>
 * <li>A palette key is a block id with optional {@code [key=value,...]} properties; a missing namespace is
 * {@code minecraft}.</li>
 * </ul>
 *
 * <p>Architect's conventions: a template cell it does not write is {@code minecraft:structure_void} in a file it writes, and a
 * {@code structure_void} cell in a file it reads is not written; air is air. {@code Offset} puts the template's ground row
 * ({@code groundY}) at y 0, so reading takes {@code groundY = -Offset.y} when that is a row of the schematic above its bottom
 * row (else 1, as a {@code .nbt} import).
 */
public final class Schematic {
	/** The template cap (docs/CONTRACT.md "Phase 2": the largest design; a schematic past it is refused TOO_LARGE). */
	public static final int MAX_X = 96;
	public static final int MAX_Y = 64;
	public static final int MAX_Z = 96;
	/** A file bigger than this is refused before it is read (a 96 x 64 x 96 schematic with block entities is far smaller). */
	public static final long MAX_FILE_BYTES = 32L * 1024 * 1024;
	/** The NBT read quota (uncompressed). */
	public static final long NBT_QUOTA = 256L * 1024 * 1024;
	public static final String STRUCTURE_VOID = "minecraft:structure_void";
	/**
	 * The DataVersion from which a structure palette entry is {@code {id, properties}} (vanilla's BlockStateFieldNamesFix, schema
	 * 5006); before it {@code {Name, Properties}}. {@link #toStructure} writes the form of the file's DataVersion, so the
	 * data fixers see what a structure of that version had.
	 */
	public static final int STATE_FIELD_NAMES_DV = 5006;
	public static final String AIR = "minecraft:air";

	private Schematic() {
	}

	/** Why a file can't be read: FORMAT or TOO_LARGE, with a message for the player. */
	public static final class Refused extends Exception {
		private final Reason reason;

		public Refused(Reason reason, String message) {
			super(message);
			this.reason = reason;
		}

		public Reason reason() {
			return reason;
		}
	}

	/**
	 * A block entity of a schematic: its cell and its data in the chunk format with {@code id} (the {@code Id}) and without
	 * {@code x}/{@code y}/{@code z}.
	 */
	public record BlockEntity(int x, int y, int z, String id, CompoundTag data) {
	}

	/**
	 * A read schematic.
	 *
	 * @param palette the state string of each palette index (null for an unused gap)
	 * @param data one palette index per cell, {@code x + z * width + y * width * length}
	 * @param entities how many entities the file has (skipped)
	 * @param biomes whether it has biome data (ignored)
	 */
	public record Parsed(int version, int dataVersion, int width, int height, int length, int[] offset, String[] palette, int[] data,
		List<BlockEntity> blockEntities, @Nullable String name, @Nullable String author, @Nullable Long date, int entities, boolean biomes) {
		public int index(int x, int y, int z) {
			return x + z * width + y * width * length;
		}

		/**
		 * {@code -Offset.y} when it is a row of the schematic above its bottom row (a template's ground row has its floor row
		 * under it: groundY at least 1), else {@code fallback}.
		 */
		public int groundY(int fallback) {
			int g = -offset[1];
			return g >= 1 && g < height ? g : fallback;
		}
	}

	// ------------------------------------------------------------------ reading

	/** Reads gzipped (or raw) schematic bytes. */
	public static Parsed read(byte[] bytes, int currentDataVersion) throws Refused {
		if (bytes.length > MAX_FILE_BYTES) {
			throw new Refused(Reason.TOO_LARGE, bytes.length + " bytes is more than the " + MAX_FILE_BYTES + " a schematic file may have");
		}
		CompoundTag root;
		try {
			boolean gz = bytes.length > 2 && (bytes[0] & 0xff) == 0x1f && (bytes[1] & 0xff) == 0x8b;
			root = gz ? NbtIo.readCompressed(new ByteArrayInputStream(bytes), NbtAccounter.create(NBT_QUOTA))
				: NbtIo.read(new java.io.DataInputStream(new ByteArrayInputStream(bytes)), NbtAccounter.create(NBT_QUOTA));
		} catch (IOException | RuntimeException e) {
			throw new Refused(Reason.FORMAT, "not an NBT file (" + e.getMessage() + ")");
		}
		return read(root, currentDataVersion);
	}

	/** Reads a schematic's root compound (spec v2 or v3). */
	public static Parsed read(CompoundTag root, int currentDataVersion) throws Refused {
		CompoundTag s;
		boolean wrapped = root.get("Schematic") instanceof CompoundTag;
		s = wrapped ? root.getCompoundOrEmpty("Schematic") : root;
		Integer version = num(s, "Version");
		if (version == null) {
			throw new Refused(Reason.FORMAT, "not a Sponge schematic (no Version)");
		}
		if (version != 2 && version != 3) {
			throw new Refused(Reason.FORMAT, "Sponge schematic version " + version + " is not supported (2 and 3 are)");
		}
		Integer dv = num(s, "DataVersion");
		if (dv == null) {
			throw new Refused(Reason.FORMAT, "no DataVersion");
		}
		if (dv > currentDataVersion) {
			throw new Refused(Reason.FORMAT, "made by a newer game (DataVersion " + dv + "; this game is " + currentDataVersion + ")");
		}
		Integer w = num(s, "Width");
		Integer h = num(s, "Height");
		Integer l = num(s, "Length");
		if (w == null || h == null || l == null) {
			throw new Refused(Reason.FORMAT, "no Width, Height or Length");
		}
		int width = w & 0xFFFF;
		int height = h & 0xFFFF;
		int length = l & 0xFFFF;
		if (width == 0 || height == 0 || length == 0) {
			throw new Refused(Reason.FORMAT, "an empty schematic (" + width + "x" + height + "x" + length + ")");
		}
		if (width > MAX_X || height > MAX_Y || length > MAX_Z) {
			throw new Refused(Reason.TOO_LARGE, width + "x" + height + "x" + length + " is past the template cap of " + MAX_X + "x" + MAX_Y + "x"
				+ MAX_Z);
		}
		int[] offset = {0, 0, 0};
		if (s.contains("Offset")) {
			int[] o = s.getIntArray("Offset").orElse(null);
			if (o == null || o.length != 3) {
				throw new Refused(Reason.FORMAT, "Offset is not 3 integers");
			}
			offset = o.clone();
		}
		CompoundTag blocks;
		String dataKey;
		if (version == 3) {
			if (!(s.get("Blocks") instanceof CompoundTag)) {
				throw new Refused(Reason.FORMAT, "no Blocks (a schematic without blocks has nothing to import)");
			}
			blocks = s.getCompoundOrEmpty("Blocks");
			dataKey = "Data";
		} else {
			blocks = s;
			dataKey = "BlockData";
		}
		if (!(blocks.get("Palette") instanceof CompoundTag pal)) {
			throw new Refused(Reason.FORMAT, "no Palette");
		}
		int max = -1;
		Map<Integer, String> byIndex = new HashMap<>();
		for (String key : pal.keySet()) {
			Integer i = num(pal, key);
			if (i == null || i < 0 || i > 1 << 20) {
				throw new Refused(Reason.FORMAT, "palette entry " + key + " has no valid index");
			}
			if (byIndex.put(i, key) != null) {
				throw new Refused(Reason.FORMAT, "palette index " + i + " is used twice");
			}
			max = Math.max(max, i);
		}
		if (max < 0) {
			throw new Refused(Reason.FORMAT, "the palette is empty");
		}
		String[] palette = new String[max + 1];
		byIndex.forEach((i, k) -> palette[i] = k);
		byte[] raw = blocks.getByteArray(dataKey).orElse(null);
		if (raw == null) {
			throw new Refused(Reason.FORMAT, "no block data (" + dataKey + ")");
		}
		int cells = width * height * length;
		int[] data = new int[cells];
		int n = 0;
		int p = 0;
		while (p < raw.length) {
			int value = 0;
			int shift = 0;
			while (true) {
				if (p >= raw.length) {
					throw new Refused(Reason.FORMAT, "the block data ends inside a varint");
				}
				int b = raw[p++] & 0xff;
				value |= (b & 0x7f) << shift;
				if ((b & 0x80) == 0) {
					break;
				}
				shift += 7;
				if (shift > 28) {
					throw new Refused(Reason.FORMAT, "a varint in the block data is too long");
				}
			}
			if (n >= cells) {
				throw new Refused(Reason.FORMAT, "the block data has more than the " + cells + " cells of " + width + "x" + height + "x" + length);
			}
			if (value < 0 || value >= palette.length || palette[value] == null) {
				throw new Refused(Reason.FORMAT, "the block data names palette index " + value + ", which the palette lacks");
			}
			data[n++] = value;
		}
		if (n != cells) {
			throw new Refused(Reason.FORMAT, "the block data has " + n + " cells, not the " + cells + " of " + width + "x" + height + "x" + length);
		}
		List<BlockEntity> bes = new ArrayList<>();
		ListTag list = blocks.getListOrEmpty("BlockEntities");
		for (int i = 0; i < list.size(); i++) {
			if (!(list.get(i) instanceof CompoundTag be)) {
				throw new Refused(Reason.FORMAT, "block entity " + i + " is not a compound");
			}
			int[] pos = be.getIntArray("Pos").orElse(null);
			if (pos == null || pos.length != 3) {
				throw new Refused(Reason.FORMAT, "block entity " + i + " has no Pos of 3 integers");
			}
			if (pos[0] < 0 || pos[1] < 0 || pos[2] < 0 || pos[0] >= width || pos[1] >= height || pos[2] >= length) {
				throw new Refused(Reason.FORMAT, "block entity " + i + " at " + pos[0] + "," + pos[1] + "," + pos[2] + " is outside the schematic");
			}
			String id = be.getString("Id").or(() -> be.getString("id")).orElse(null);
			if (id == null || id.isBlank()) {
				throw new Refused(Reason.FORMAT, "block entity " + i + " has no Id");
			}
			CompoundTag d = new CompoundTag();
			if (version == 3) {
				if (be.get("Data") instanceof CompoundTag dd) {
					d = dd.copy();
				}
			} else {
				for (String k : be.keySet()) {
					if (!k.equals("Pos") && !k.equals("Id") && !k.equals("id") && !k.equals("Extra")) {
						d.put(k, be.get(k).copy());
					}
				}
				if (be.get("Extra") instanceof CompoundTag extra) {
					for (String k : extra.keySet()) {
						d.put(k, extra.get(k).copy());
					}
				}
			}
			d.remove("x");
			d.remove("y");
			d.remove("z");
			d.remove("Id");
			d.putString("id", namespaced(id));
			bes.add(new BlockEntity(pos[0], pos[1], pos[2], namespaced(id), d));
		}
		CompoundTag meta = s.getCompoundOrEmpty("Metadata");
		String name = meta.getString("Name").orElse(null);
		String author = meta.getString("Author").orElse(null);
		Long date = meta.get("Date") != null ? meta.get("Date").asLong().orElse(null) : null;
		int entities = s.getListOrEmpty("Entities").size();
		boolean biomes = s.contains("Biomes") || s.contains("BiomeData");
		return new Parsed(version, dv, width, height, length, offset, palette, data, List.copyOf(bes), name, author, date, entities, biomes);
	}

	private static @Nullable Integer num(CompoundTag t, String key) {
		Tag v = t.get(key);
		if (v == null) {
			return null;
		}
		return switch (v.getId()) {
			case Tag.TAG_BYTE, Tag.TAG_SHORT, Tag.TAG_INT -> v.asInt().orElse(null);
			default -> null;
		};
	}

	static String namespaced(String id) {
		String s = id.strip();
		return s.indexOf(':') < 0 ? "minecraft:" + s : s;
	}

	/** A block state string's id ({@code ns:name}, namespace added) and properties, in their order. */
	public record State(String name, Map<String, String> properties) {
	}

	/** Parses {@code ns:name[k=v,...]}. */
	public static State parseState(String s) throws Refused {
		String str = s.strip();
		int open = str.indexOf('[');
		String name = open < 0 ? str : str.substring(0, open);
		Map<String, String> props = new LinkedHashMap<>();
		if (open >= 0) {
			if (!str.endsWith("]")) {
				throw new Refused(Reason.FORMAT, "palette entry " + s + ": properties are not closed by ]");
			}
			String body = str.substring(open + 1, str.length() - 1).strip();
			if (!body.isEmpty()) {
				for (String kv : body.split(",")) {
					int eq = kv.indexOf('=');
					if (eq <= 0 || eq == kv.length() - 1) {
						throw new Refused(Reason.FORMAT, "palette entry " + s + ": " + kv + " is not key=value");
					}
					props.put(kv.substring(0, eq).strip(), kv.substring(eq + 1).strip());
				}
			}
		}
		if (name.isEmpty() || !name.matches("([a-z0-9_.-]+:)?[a-z0-9_./-]+")) {
			throw new Refused(Reason.FORMAT, "palette entry " + s + " is not a block id");
		}
		return new State(namespaced(name), props);
	}

	/**
	 * The schematic as a vanilla structure template tag at the file's own DataVersion (for vanilla's STRUCTURE data fixer): the
	 * palette in order of first use (y, then z, then x), one block per cell except {@code structure_void} (not written), the
	 * block entities' data as each block's {@code nbt}, and no entities.
	 */
	public static CompoundTag toStructure(Parsed p) throws Refused {
		State[] states = new State[p.palette().length];
		for (int i = 0; i < states.length; i++) {
			if (p.palette()[i] != null) {
				states[i] = parseState(p.palette()[i]);
			}
		}
		Map<Long, CompoundTag> bes = new HashMap<>();
		for (BlockEntity be : p.blockEntities()) {
			bes.put(key(be.x(), be.y(), be.z()), be.data());
		}
		int[] remap = new int[states.length];
		java.util.Arrays.fill(remap, -1);
		boolean legacy = p.dataVersion() < STATE_FIELD_NAMES_DV;
		ListTag palette = new ListTag();
		ListTag blocks = new ListTag();
		for (int y = 0; y < p.height(); y++) {
			for (int z = 0; z < p.length(); z++) {
				for (int x = 0; x < p.width(); x++) {
					int pi = p.data()[p.index(x, y, z)];
					State st = states[pi];
					if (STRUCTURE_VOID.equals(st.name())) {
						continue;
					}
					if (remap[pi] < 0) {
						remap[pi] = palette.size();
						CompoundTag e = new CompoundTag();
						e.putString(legacy ? "Name" : "id", st.name());
						if (!st.properties().isEmpty()) {
							CompoundTag props = new CompoundTag();
							st.properties().forEach(props::putString);
							e.put(legacy ? "Properties" : "properties", props);
						}
						palette.add(e);
					}
					CompoundTag b = new CompoundTag();
					ListTag pos = new ListTag();
					pos.add(IntTag.valueOf(x));
					pos.add(IntTag.valueOf(y));
					pos.add(IntTag.valueOf(z));
					b.put("pos", pos);
					b.putInt("state", remap[pi]);
					CompoundTag nbt = bes.get(key(x, y, z));
					if (nbt != null) {
						b.put("nbt", nbt.copy());
					}
					blocks.add(b);
				}
			}
		}
		CompoundTag t = new CompoundTag();
		ListTag size = new ListTag();
		size.add(IntTag.valueOf(p.width()));
		size.add(IntTag.valueOf(p.height()));
		size.add(IntTag.valueOf(p.length()));
		t.put("size", size);
		t.put("palette", palette);
		t.put("blocks", blocks);
		t.put("entities", new ListTag());
		t.putInt("DataVersion", p.dataVersion());
		return t;
	}

	private static long key(int x, int y, int z) {
		return ((long) x << 42) | ((long) y << 21) | z;
	}

	// ------------------------------------------------------------------ writing

	/**
	 * One cell to write: its state string ({@code ns:name[k=v,...]}, the properties in the block's own order), or null for a
	 * cell the template does not write ({@code structure_void}).
	 */
	public interface Cells {
		@Nullable String state(int x, int y, int z);
	}

	/** What a version-3 file says about itself. */
	public record Meta(String name, String author, long date, int dataVersion, int groundY) {
	}

	/**
	 * A version-3 schematic: the palette in order of first use in y, z, x order (so the bytes depend only on the cells),
	 * {@code Offset} {@code [0, -groundY, 0]}, {@code Metadata {Name, Author, Date}}, the block entities sorted by position with
	 * their data minus {@code id}/{@code x}/{@code y}/{@code z}.
	 */
	public static CompoundTag write(int width, int height, int length, Cells cells, List<BlockEntity> blockEntities, Meta meta) {
		Map<String, Integer> palette = new LinkedHashMap<>();
		ByteArrayOutputStream data = new ByteArrayOutputStream(width * height * length);
		for (int y = 0; y < height; y++) {
			for (int z = 0; z < length; z++) {
				for (int x = 0; x < width; x++) {
					String s = cells.state(x, y, z);
					int i = palette.computeIfAbsent(s == null ? STRUCTURE_VOID : s, k -> palette.size());
					while ((i & ~0x7f) != 0) {
						data.write((i & 0x7f) | 0x80);
						i >>>= 7;
					}
					data.write(i);
				}
			}
		}
		CompoundTag pal = new CompoundTag();
		palette.forEach(pal::putInt);
		ListTag bes = new ListTag();
		List<BlockEntity> sorted = new ArrayList<>(blockEntities);
		sorted.sort(java.util.Comparator.comparingInt(BlockEntity::y).thenComparingInt(BlockEntity::z).thenComparingInt(BlockEntity::x));
		for (BlockEntity be : sorted) {
			CompoundTag o = new CompoundTag();
			o.put("Pos", new IntArrayTag(new int[] {be.x(), be.y(), be.z()}));
			o.putString("Id", be.id());
			CompoundTag d = be.data().copy();
			d.remove("id");
			d.remove("x");
			d.remove("y");
			d.remove("z");
			o.put("Data", d);
			bes.add(o);
		}
		CompoundTag blocks = new CompoundTag();
		blocks.put("Palette", pal);
		blocks.put("Data", new ByteArrayTag(data.toByteArray()));
		blocks.put("BlockEntities", bes);
		CompoundTag md = new CompoundTag();
		md.putString("Name", meta.name());
		md.putString("Author", meta.author());
		md.putLong("Date", meta.date());
		CompoundTag s = new CompoundTag();
		s.putInt("Version", 3);
		s.putInt("DataVersion", meta.dataVersion());
		s.put("Metadata", md);
		s.putShort("Width", (short) width);
		s.putShort("Height", (short) height);
		s.putShort("Length", (short) length);
		s.put("Offset", new IntArrayTag(new int[] {0, -meta.groundY(), 0}));
		s.put("Blocks", blocks);
		CompoundTag root = new CompoundTag();
		root.put("Schematic", s);
		return root;
	}

	/**
	 * The gzipped bytes of a root compound, platform-independent: compound keys written in sorted order, deflate level 9 with
	 * the JDK's own zlib (the same bytes on macOS and Linux, checked in the SCH gate), the JDK's fixed gzip header (no name, no
	 * time).
	 */
	public static byte[] gzip(CompoundTag root) {
		try {
			ByteArrayOutputStream bo = new ByteArrayOutputStream();
			try (GZIPOutputStream gz = new GZIPOutputStream(bo) {
				{
					def.setLevel(9);
				}
			}) {
				gz.write(raw(root)); // one write, as tools/lib/SchemGzip.java (the Linux check) does
			}
			return bo.toByteArray();
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	/** The uncompressed NBT bytes of a root compound (named ""), compound keys in sorted order. */
	public static byte[] raw(CompoundTag root) {
		try {
			ByteArrayOutputStream bo = new ByteArrayOutputStream();
			try (DataOutputStream out = new DataOutputStream(bo)) {
				out.writeByte(Tag.TAG_COMPOUND);
				out.writeUTF("");
				writeSorted(root, out);
			}
			return bo.toByteArray();
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	/** A tag's payload with every compound's keys in sorted order. */
	private static void writeSorted(Tag t, DataOutput out) throws IOException {
		if (t instanceof CompoundTag c) {
			for (String k : new TreeSet<>(c.keySet())) {
				Tag v = c.get(k);
				out.writeByte(v.getId());
				out.writeUTF(k);
				writeSorted(v, out);
			}
			out.writeByte(Tag.TAG_END);
		} else if (t instanceof ListTag l) {
			byte type = l.isEmpty() ? Tag.TAG_END : l.get(0).getId();
			out.writeByte(type);
			out.writeInt(l.size());
			for (Tag v : l) {
				writeSorted(v, out);
			}
		} else {
			t.write(out);
		}
	}

	/** A structure palette entry's block id ({@code id}, or the older {@code Name}). */
	public static String stateName(CompoundTag e) {
		return e.getString("id").orElseGet(() -> e.getStringOr("Name", ""));
	}

	/** The block names a palette uses that {@code known} does not hold, sorted. */
	public static List<String> unknownNames(CompoundTag structure, java.util.function.Predicate<String> known) {
		TreeSet<String> out = new TreeSet<>();
		ListTag pal = structure.getListOrEmpty("palette");
		for (int i = 0; i < pal.size(); i++) {
			String n = stateName(pal.getCompoundOrEmpty(i));
			if (!known.test(n)) {
				out.add(n);
			}
		}
		return List.copyOf(out);
	}

	/**
	 * Replaces every palette entry {@code known} does not hold with {@code replacement} (its default state) and drops the block
	 * entity data of the cells that had one; returns the replaced names (sorted).
	 */
	public static List<String> replaceUnknown(CompoundTag structure, java.util.function.Predicate<String> known, String replacement) {
		TreeMap<Integer, String> replaced = new TreeMap<>();
		ListTag pal = structure.getListOrEmpty("palette");
		for (int i = 0; i < pal.size(); i++) {
			CompoundTag e = pal.getCompoundOrEmpty(i);
			String n = stateName(e);
			if (!known.test(n)) {
				replaced.put(i, n);
				e.remove("Name");
				e.remove("Properties");
				e.remove("properties");
				e.putString("id", replacement);
			}
		}
		if (!replaced.isEmpty()) {
			ListTag blocks = structure.getListOrEmpty("blocks");
			for (int i = 0; i < blocks.size(); i++) {
				CompoundTag b = blocks.getCompoundOrEmpty(i);
				if (replaced.containsKey(b.getIntOr("state", -1))) {
					b.remove("nbt");
				}
			}
		}
		return List.copyOf(new TreeSet<>(replaced.values()));
	}
}
