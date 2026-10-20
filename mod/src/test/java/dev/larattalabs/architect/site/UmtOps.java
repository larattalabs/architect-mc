package dev.larattalabs.architect.site;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import org.jspecify.annotations.Nullable;

/**
 * The undo model tester's scenario language (docs/UMT.md): a world seed and a list of operations. Operations name placements by
 * their ordinal among the ones standing (modulo), so any sublist is still a valid scenario (shrinking drops operations freely).
 */
final class UmtOps {
	private UmtOps() {
	}

	enum Kind {
		/** A building's site: a BOX entry over its box (SiteJournal.begin / complete). */
		SITE,
		/** A lot: a site whose record masks irrigation cells out of its BOX entry (LotMask). */
		LOT,
		/** A road: a CELL entry, a path with lamp posts beside it (InfraJob's P3/P7). */
		ROAD,
		/** A region tile: a CELL terrain entry that skips owned cells and clears the dependents over what it changes (TileCheck's rules). */
		TILE
	}

	/**
	 * Where a crash halts a change: {@code point} names the durable step (docs/UMT.md "Crash points"); {@code io} the commit's I/O step
	 * for a fault inside a commit ({@code write}, {@code move}, {@code read back}, {@code index}, {@code committed}, {@code deleted});
	 * {@code n} how many cells or sites were written first; {@code save} whether the world autosaved just before.
	 */
	record Crash(String point, @Nullable String io, int n, boolean save) {
		@Override
		public String toString() {
			return point + (io != null ? "/" + io : "") + (n > 0 ? "+" + n : "") + (save ? "+save" : "");
		}
	}

	sealed interface Op permits Place, Remove, RemoveGroup, Drift, Edit, Autosave, Restart {
	}

	/** Places a change of {@code kind} over [x, x+w) x [z, z+d), {@code h} high; {@code group} 0 is none. */
	record Place(Kind kind, int x, int z, int w, int d, int h, long design, int group, @Nullable Crash crash) implements Op {
	}

	/** Removes the standing placement {@code ordinal} (modulo the standing count). */
	record Remove(int ordinal, @Nullable Crash crash) implements Op {
	}

	/** Removes a group's standing members as one undo (Groups: one plan, one commit, writes last placed first). */
	record RemoveGroup(int group, @Nullable Crash crash) implements Op {
	}

	/** The world changes a cell of a standing placement by itself (weathering, drying, spreading, flowing, freezing). */
	record Drift(int ordinal, long seed) implements Op {
	}

	/** A player changes a cell of a standing placement (waxes, mines, places a block of their own). */
	record Edit(int ordinal, long seed) implements Op {
	}

	/** The world autosaves (a crash after it keeps the world as it is now). */
	record Autosave() implements Op {
	}

	/** The world stops cleanly and starts again (settles the journal). */
	record Restart() implements Op {
	}

	/** A scenario: the world's seed, its operations, and what the generator allowed (for the report). */
	record Scenario(long worldSeed, List<Op> ops, Gen gen) {
		Scenario with(List<Op> o) {
			return new Scenario(worldSeed, o, gen);
		}

		@Override
		public String toString() {
			StringBuilder b = new StringBuilder("world " + worldSeed + " (" + gen + "), " + ops.size() + " ops:");
			for (Op o : ops) {
				b.append("\n  ").append(o);
			}
			return b.toString();
		}
	}

	/**
	 * What a generator draws: crashes, natural drift, player edits, and the configurations known to be findings (kept out of the CI
	 * set until the coordinator decides, docs/UMT.md "Findings").
	 */
	record Gen(int ops, boolean crashes, boolean drift, boolean edits, boolean findings) {
		static final Gen PLAIN = new Gen(10, false, false, false, false);
		static final Gen CRASH = new Gen(10, true, false, false, false);
		static final Gen DRIFT = new Gen(10, false, true, true, false);
		static final Gen ALL = new Gen(14, true, true, true, false);

		@Override
		public String toString() {
			return "ops " + ops + (crashes ? " crashes" : "") + (drift ? " drift" : "") + (edits ? " edits" : "") + (findings ? " findings" : "");
		}
	}

	static final String[] IO = {"write", "move", "read back", "index", "committed", "deleted"};
	static final String[] PLACE_POINTS = {"P3", "K2", "P5", "P6", "P7", "P8"};
	static final String[] REMOVE_POINTS = {"R2", "K6", "K7", "R5"};

	static Scenario generate(long seed, Gen g) {
		Random r = new Random(seed);
		List<Op> ops = new ArrayList<>();
		int n = 3 + r.nextInt(g.ops());
		for (int i = 0; i < n; i++) {
			int k = r.nextInt(100);
			if (k < 45) {
				ops.add(place(r, g));
			} else if (k < 60) {
				ops.add(new Remove(r.nextInt(8), crash(r, g, false)));
			} else if (k < 66) {
				ops.add(new RemoveGroup(1 + r.nextInt(3), crash(r, g, false)));
			} else if (k < 76 && g.drift()) {
				ops.add(new Drift(r.nextInt(8), r.nextLong()));
			} else if (k < 84 && g.edits()) {
				ops.add(new Edit(r.nextInt(8), r.nextLong()));
			} else if (k < 92) {
				ops.add(new Autosave());
			} else {
				ops.add(new Restart());
			}
		}
		return new Scenario(seed * 31 + 7, ops, g);
	}

	static Place place(Random r, Gen g) {
		Kind kind = Kind.values()[r.nextInt(Kind.values().length)];
		int w = 2 + r.nextInt(kind == Kind.ROAD ? 14 : 8);
		int d = kind == Kind.ROAD ? 1 + r.nextInt(2) : 2 + r.nextInt(8);
		if (kind == Kind.ROAD && r.nextBoolean()) {
			int t = w;
			w = d;
			d = t;
		}
		int x = UmtWorld.X0 + 1 + r.nextInt(UmtWorld.X1 - UmtWorld.X0 - w - 1);
		int z = UmtWorld.Z0 + 1 + r.nextInt(UmtWorld.Z1 - UmtWorld.Z0 - d - 1);
		int h = 2 + r.nextInt(5);
		return new Place(kind, x, z, w, d, h, r.nextLong(), r.nextInt(4), crash(r, g, true));
	}

	static @Nullable Crash crash(Random r, Gen g, boolean place) {
		if (!g.crashes() || r.nextInt(3) != 0) {
			return null;
		}
		String[] pts = place ? PLACE_POINTS : REMOVE_POINTS;
		String p = pts[r.nextInt(pts.length)];
		String io = p.equals("P3") || p.equals("P7") || p.equals("R2") ? IO[r.nextInt(IO.length)] : null;
		return new Crash(p, io, r.nextInt(40), r.nextInt(4) == 0);
	}
}
