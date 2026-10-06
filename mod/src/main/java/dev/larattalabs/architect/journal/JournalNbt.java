package dev.larattalabs.architect.journal;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.journal.Journal.HandDown;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import org.jspecify.annotations.Nullable;

/**
 * The journal's files, pure (no world, no registries). Adapted from AgentCraft {@code dev.agentcraft.journal.JournalNbt} at
 * {@code ab08a02}: the same palette encoding, but one file per entry per 512x512 column region, grouped by chunk section,
 * with a 12-bit position within the section instead of a {@code long} per cell, and the layer per entry with per-cell
 * overrides (docs/CONTRACT.md "Phase 4e contract", "On disk"):
 *
 * <pre>
 * region file: { version: 1, id, rx, rz, sections: [ { key: long, palette: [state...], idx: byte[] (2 bytes per cell,
 *   ascending), b: int[] (palette), a: int[] (palette, -1 = unknown), bn: { "&lt;i&gt;": nbt }, an: {..}, layers?: { "&lt;i&gt;": long },
 *   w?: int[] (an undo's writes, -1 = nothing), wn?: {..} } ], handed?: [{order, to, pos, was, now, wasN?, nowN?}] }
 * head file:   { version: 1, id, meta?: "json", ring?: int[] }
 * </pre>
 *
 * The structure template conversion is kept for migration and for the restore's template ({@link #toTemplate}).
 */
public final class JournalNbt {
	public static final int VERSION = 1;

	private JournalNbt() {
	}

	/** One entry's cells in one region file, by section, and the hand-downs its undo made there. Immutable. */
	public record Region(long region, TreeMap<Long, SectionCells> sections, List<HandDown> handed) {
		public Region {
			handed = List.copyOf(handed);
		}

		public int cells() {
			int n = 0;
			for (SectionCells s : sections.values()) {
				n += s.size();
			}
			return n;
		}

		long weight() {
			long w = 64;
			for (SectionCells s : sections.values()) {
				w += s.weight();
			}
			return w + handed.size() * 64L;
		}
	}

	/** An entry's head file: the site record when it was made ({@code meta}) and the 4d leaf ring side table. */
	public record Head(@Nullable JsonObject meta, int[] ring) {
		public static final Head EMPTY = new Head(null, new int[0]);
	}

	/** A palette of block states (by NBT equality) for one section. */
	private static final class Palette {
		final ListTag list = new ListTag();
		final Map<CompoundTag, Integer> ids = new HashMap<>();

		int id(CompoundTag state) {
			Integer i = ids.get(state);
			if (i == null) {
				i = list.size();
				ids.put(state, i);
				list.add(state);
			}
			return i;
		}
	}

	public static CompoundTag encode(String id, Region r, long entryLayer) {
		CompoundTag t = new CompoundTag();
		t.putInt("version", VERSION);
		t.putString("id", id);
		t.putInt("rx", Sections.rx(r.region()));
		t.putInt("rz", Sections.rz(r.region()));
		ListTag secs = new ListTag();
		for (SectionCells s : r.sections().values()) {
			secs.add(encodeSection(s, entryLayer));
		}
		t.put("sections", secs);
		if (!r.handed().isEmpty()) {
			ListTag hs = new ListTag();
			for (HandDown h : r.handed()) {
				CompoundTag ht = new CompoundTag();
				ht.putInt("order", h.order());
				ht.putString("to", h.to());
				ht.putLong("pos", h.pos());
				ht.put("was", h.was().state());
				ht.put("now", h.now().state());
				if (h.was().nbt() != null) {
					ht.put("wasN", h.was().nbt());
				}
				if (h.now().nbt() != null) {
					ht.put("nowN", h.now().nbt());
				}
				hs.add(ht);
			}
			t.put("handed", hs);
		}
		return t;
	}

	private static CompoundTag encodeSection(SectionCells s, long entryLayer) {
		CompoundTag t = new CompoundTag();
		t.putLong("key", s.key);
		Palette pal = new Palette();
		int n = s.size();
		byte[] idx = new byte[n * 2];
		int[] b = new int[n];
		int[] a = new int[n];
		CompoundTag bn = new CompoundTag();
		CompoundTag an = new CompoundTag();
		CompoundTag layers = new CompoundTag();
		for (int k = 0; k < n; k++) {
			int i = s.idx[k];
			idx[k * 2] = (byte) (i >> 8);
			idx[k * 2 + 1] = (byte) i;
			b[k] = pal.id(s.before[k].state());
			if (s.before[k].nbt() != null) {
				bn.put(Integer.toString(k), s.before[k].nbt());
			}
			Value av = s.after[k];
			if (av == null) {
				a[k] = -1;
			} else {
				a[k] = pal.id(av.state());
				if (av.nbt() != null) {
					an.put(Integer.toString(k), av.nbt());
				}
			}
			if (s.layer[k] != entryLayer) {
				layers.putLong(Integer.toString(k), s.layer[k]);
			}
		}
		t.putByteArray("idx", idx);
		t.putIntArray("b", b);
		t.putIntArray("a", a);
		if (!bn.isEmpty()) {
			t.put("bn", bn);
		}
		if (!an.isEmpty()) {
			t.put("an", an);
		}
		if (!layers.isEmpty()) {
			t.put("layers", layers);
		}
		if (s.written != null) {
			int[] w = new int[n];
			CompoundTag wn = new CompoundTag();
			for (int k = 0; k < n; k++) {
				Value v = s.written[k];
				if (v == null) {
					w[k] = -1;
				} else {
					w[k] = pal.id(v.state());
					if (v.nbt() != null) {
						wn.put(Integer.toString(k), v.nbt());
					}
				}
			}
			t.putIntArray("w", w);
			if (!wn.isEmpty()) {
				t.put("wn", wn);
			}
		}
		t.put("palette", pal.list);
		return t;
	}

	/** Reads {@link #encode} output; throws IllegalArgumentException when it is not one. */
	public static Region decode(CompoundTag t, long entryLayer) {
		if (t.getIntOr("version", 0) != VERSION) {
			throw new IllegalArgumentException("not a journal region file (version " + t.getIntOr("version", 0) + ")");
		}
		TreeMap<Long, SectionCells> sections = new TreeMap<>();
		for (Tag x : t.getListOrEmpty("sections")) {
			SectionCells s = decodeSection((CompoundTag) x, entryLayer);
			sections.put(s.key, s);
		}
		List<HandDown> handed = new ArrayList<>();
		for (Tag x : t.getListOrEmpty("handed")) {
			CompoundTag h = (CompoundTag) x;
			handed.add(new HandDown(h.getIntOr("order", 0), h.getStringOr("to", ""), h.getLongOr("pos", 0L),
				Value.of(h.getCompoundOrEmpty("was"), h.getCompound("wasN").orElse(null)), Value.of(h.getCompoundOrEmpty("now"),
					h.getCompound("nowN").orElse(null))));
		}
		return new Region(Sections.region(t.getIntOr("rx", 0), t.getIntOr("rz", 0)), sections, handed);
	}

	private static SectionCells decodeSection(CompoundTag t, long entryLayer) {
		long key = t.getLongOr("key", 0L);
		ListTag palList = t.getListOrEmpty("palette");
		CompoundTag[] pal = new CompoundTag[palList.size()];
		Value[] plain = new Value[pal.length];
		for (int i = 0; i < pal.length; i++) {
			pal[i] = Value.intern(palList.getCompoundOrEmpty(i));
			plain[i] = new Value(pal[i], null);
		}
		byte[] ib = t.getByteArray("idx").orElse(new byte[0]);
		int n = ib.length / 2;
		int[] b = t.getIntArray("b").orElse(new int[0]);
		int[] a = t.getIntArray("a").orElse(new int[0]);
		if (b.length != n || a.length != n) {
			throw new IllegalArgumentException("section " + key + ": cell arrays differ in length");
		}
		CompoundTag bn = t.getCompoundOrEmpty("bn");
		CompoundTag an = t.getCompoundOrEmpty("an");
		CompoundTag layers = t.getCompoundOrEmpty("layers");
		short[] idx = new short[n];
		Value[] before = new Value[n];
		Value[] after = new Value[n];
		long[] layer = new long[n];
		for (int k = 0; k < n; k++) {
			idx[k] = (short) ((ib[k * 2] & 0xFF) << 8 | ib[k * 2 + 1] & 0xFF);
			String ks = Integer.toString(k);
			CompoundTag bnk = bn.isEmpty() ? null : bn.getCompound(ks).orElse(null);
			before[k] = bnk == null ? plain[b[k]] : new Value(pal[b[k]], bnk);
			if (a[k] >= 0) {
				CompoundTag ank = an.isEmpty() ? null : an.getCompound(ks).orElse(null);
				after[k] = ank == null ? plain[a[k]] : new Value(pal[a[k]], ank);
			}
			layer[k] = layers.isEmpty() ? entryLayer : layers.getLongOr(ks, entryLayer);
		}
		Value[] written = null;
		int[] w = t.getIntArray("w").orElse(null);
		if (w != null) {
			if (w.length != n) {
				throw new IllegalArgumentException("section " + key + ": undo array differs in length");
			}
			CompoundTag wn = t.getCompoundOrEmpty("wn");
			written = new Value[n];
			for (int k = 0; k < n; k++) {
				if (w[k] >= 0) {
					CompoundTag x = wn.isEmpty() ? null : wn.getCompound(Integer.toString(k)).orElse(null);
					written[k] = x == null ? plain[w[k]] : new Value(pal[w[k]], x);
				}
			}
		}
		return new SectionCells(key, idx, before, after, layer, written);
	}

	public static CompoundTag encodeHead(String id, Head h) {
		CompoundTag t = new CompoundTag();
		t.putInt("version", VERSION);
		t.putString("id", id);
		if (h.meta() != null) {
			t.putString("meta", h.meta().toString());
		}
		if (h.ring().length > 0) {
			t.putIntArray("ring", h.ring());
		}
		return t;
	}

	public static Head decodeHead(CompoundTag t) {
		if (t.getIntOr("version", 0) != VERSION) {
			throw new IllegalArgumentException("not a journal head file");
		}
		String m = t.getStringOr("meta", "");
		return new Head(m.isEmpty() ? null : JsonParser.parseString(m).getAsJsonObject(), t.getIntArray("ring").orElse(new int[0]));
	}

	// ------------------------------------------------------------------ structure templates (AgentCraft, kept)

	/** A structure template's blocks as world position -> value, in its block order. Pure. */
	public static LinkedHashMap<Long, Value> values(CompoundTag tpl, int minX, int minY, int minZ) {
		ListTag palette = tpl.getListOrEmpty("palette");
		CompoundTag[] pal = new CompoundTag[palette.size()];
		for (int i = 0; i < pal.length; i++) {
			pal[i] = Value.intern(palette.getCompoundOrEmpty(i));
		}
		ListTag blocks = tpl.getListOrEmpty("blocks");
		LinkedHashMap<Long, Value> out = new LinkedHashMap<>();
		for (int i = 0; i < blocks.size(); i++) {
			CompoundTag bt = blocks.getCompoundOrEmpty(i);
			ListTag p = bt.getListOrEmpty("pos");
			long pos = Journal.pos(minX + p.getIntOr(0, 0), minY + p.getIntOr(1, 0), minZ + p.getIntOr(2, 0));
			int si = bt.getIntOr("state", 0);
			out.put(pos, new Value(si >= 0 && si < pal.length ? pal[si] : Journal.AIR.state(), bt.getCompound("nbt").orElse(null)));
		}
		return out;
	}

	/**
	 * A structure template (the format {@code StructureTemplate.load} reads) of {@code values} (world position -> value, in
	 * the order given) relative to {@code (minX, minY, minZ)}, {@code size} big. {@code dataVersion} is copied when given.
	 * Pure.
	 */
	public static CompoundTag toTemplate(Map<Long, Value> values, int minX, int minY, int minZ, int sizeX, int sizeY, int sizeZ, int dataVersion) {
		CompoundTag t = new CompoundTag();
		Palette pal = new Palette();
		ListTag blocks = new ListTag();
		for (var e : values.entrySet()) {
			CompoundTag bt = new CompoundTag();
			ListTag p = new ListTag();
			p.add(IntTag.valueOf(Journal.x(e.getKey()) - minX));
			p.add(IntTag.valueOf(Journal.y(e.getKey()) - minY));
			p.add(IntTag.valueOf(Journal.z(e.getKey()) - minZ));
			bt.put("pos", p);
			bt.putInt("state", pal.id(e.getValue().state()));
			if (e.getValue().nbt() != null) {
				bt.put("nbt", e.getValue().nbt());
			}
			blocks.add(bt);
		}
		ListTag size = new ListTag();
		size.add(IntTag.valueOf(sizeX));
		size.add(IntTag.valueOf(sizeY));
		size.add(IntTag.valueOf(sizeZ));
		t.put("size", size);
		t.put("blocks", blocks);
		t.put("palette", pal.list);
		t.put("entities", new ListTag());
		if (dataVersion > 0) {
			t.putInt("DataVersion", dataVersion);
		}
		return t;
	}

	/** Whether {@code t} is a structure template (a 4d snapshot); used by the migration. */
	static boolean isTemplate(CompoundTag t) {
		return t.get("blocks") instanceof ListTag && t.get("palette") instanceof ListTag && t.get("size") instanceof ListTag;
	}
}
