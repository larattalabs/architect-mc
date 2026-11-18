package dev.larattalabs.architect.site;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.LongPredicate;
import java.util.function.Predicate;
import org.jspecify.annotations.Nullable;

/**
 * (slice T3a, the T3 design §1 "Plan (R-1)" and §4) The plan-time rules of adoption on the txn layer ({@code pile.adopt}), pure: no
 * Minecraft types, nothing read or written here. Each candidate crate's fate is decided once, from what the plan read at its cell under the
 * holds: JOIN (it reads as its owner's and its adoption key is not credited), DEFER (unreadable, retagged, not a crate, or its paid record
 * would read chunks past the load bound; left out of the plan and the resources, its block, stock, journal kind and references untouched),
 * and the two legacy fates of a key the ledger already credited (JOINED: the crate is gone, the start's repair clears references; FINISH:
 * an A-model crate still stands, held for ops, never drained, never credited twice: Noah's decision 3).
 *
 * <p>Overflow (Noah's decision 1): a JOIN crate's whole stock enters the stock, past capacity (OVF's keyed rule); there is no owed entry
 * and no split to plan. Not called by the runtime yet: T3b builds {@code pile.adopt} on it once T2b's crate hold and {@code crate.take}
 * land.
 */
public final class AdoptPlan {
	private AdoptPlan() {
	}

	/** A candidate's fate. */
	public enum Fate {
		JOIN,
		DEFER,
		/** Legacy: the key is credited and the crate is gone (an adoption stopped between its saves). */
		JOINED,
		/** Legacy: the key is credited and a crate block still stands at the cell (an A-model save): held for ops. */
		FINISH,
		/**
		 * (slice T3b, DFG's fix round, GPT P1) Its cell read and no crate block of any owner stands there, its key not credited: nothing to
		 * take (no crate, no stock). Main's path inside the txn: the cell restored, the journal kind released, its targets lose the reference
		 * and a building one joins the feed (deferring it kept a building target waiting for a crate that does not exist, forever).
		 */
		GONE
	}

	/** Why a crate is deferred; {@link #wire} is the stable value {@code AdoptResult.deferred} carries. */
	public enum Defer {
		UNREADABLE("unreadable"),
		RETAGGED("retagged"),
		NOT_A_CRATE("not a crate"),
		CHUNKS_UNLOADED("chunks unloaded");

		public final String wire;

		Defer(String wire) {
			this.wire = wire;
		}
	}

	/**
	 * What the plan read at one candidate: {@code key} the crate owner a record names (a site id, or {@code group:<id>}), {@code posKey}
	 * the cell packed as the adoption key packs it ({@code BlockPos.asLong}), whether a crate block stands there, whether its block entity
	 * exists, the owner id the block entity carries, and whether its ledger read.
	 */
	public record CrateRead(String key, String dim, int x, int y, int z, long posKey, boolean crateBlock, boolean hasBe, @Nullable String beOwner,
		boolean ledgerReadable, boolean known) {
		/** (T3a's shape) a cell that was read ({@code known}). */
		public CrateRead(String key, String dim, int x, int y, int z, long posKey, boolean crateBlock, boolean hasBe, @Nullable String beOwner,
			boolean ledgerReadable) {
			this(key, dim, x, y, z, posKey, crateBlock, hasBe, beOwner, ledgerReadable, true);
		}

		/** The ledger key the adoption credits: {@code adopt:<crateOwner>@<pos>} (dedupe per crate, never per call). */
		public String adoptKey() {
			return AdoptPlan.adoptKey(key, posKey);
		}

		/** The resource that holds the crate: {@code crate:<dim>@x,y,z} (CXD's removal names the same, so the two exclude each other). */
		public String resource() {
			return "crate:" + dim + "@" + x + "," + y + "," + z;
		}
	}

	public record Verdict(Fate fate, @Nullable Defer why) {
	}

	public static String adoptKey(String crateOwner, long posKey) {
		return "adopt:" + crateOwner + "@" + posKey;
	}

	/**
	 * The classifier: one candidate's fate from its read and whether its adoption key is credited. (T3b, DFG) A cell not read ({@code known}
	 * false: off the server thread, its chunk not loaded) defers whatever it holds; a read cell with no crate block is JOINED (credited) or
	 * GONE (not).
	 */
	public static Verdict classify(CrateRead r, boolean credited) {
		if (credited) {
			return r.crateBlock() ? new Verdict(Fate.FINISH, null) : r.known() ? new Verdict(Fate.JOINED, null) : new Verdict(Fate.DEFER, Defer.NOT_A_CRATE);
		}
		if (!r.crateBlock()) {
			return r.known() ? new Verdict(Fate.GONE, null) : new Verdict(Fate.DEFER, Defer.NOT_A_CRATE);
		}
		if (!r.hasBe() || !r.ledgerReadable() || r.beOwner() == null) {
			return new Verdict(Fate.DEFER, Defer.UNREADABLE);
		}
		if (!r.key().equals(r.beOwner())) {
			return new Verdict(Fate.DEFER, Defer.RETAGGED);
		}
		return new Verdict(Fate.JOIN, null);
	}

	/** The road chunk rule's answer: the chunks to load first (in order, each once) and the crates deferred past the bound. */
	public record Chunks(List<Long> load, Set<String> deferred) {
	}

	/**
	 * The road chunk rule (Noah's decision 4): every chunk a JOIN crate's paid record reads ({@code needs}: crate key -> packed chunk
	 * positions, in candidate order) is loaded before planning reads it, up to {@code bound} chunks loaded in the whole call. A crate whose
	 * not-yet-scheduled unloaded chunks would pass the bound is deferred whole ({@link Defer#CHUNKS_UNLOADED}) and charges nothing, so a later,
	 * smaller crate may still fit. A paid record is never computed from a partial rescan. A chunk two crates share is charged once.
	 */
	public static Chunks chunks(Map<String, ? extends Iterable<Long>> needs, LongPredicate loaded, int bound) {
		Set<Long> load = new LinkedHashSet<>();
		Set<String> deferred = new LinkedHashSet<>();
		for (var e : needs.entrySet()) {
			Set<Long> fresh = new LinkedHashSet<>();
			for (long c : e.getValue()) {
				if (!loaded.test(c) && !load.contains(c)) {
					fresh.add(c);
				}
			}
			if (load.size() + fresh.size() > bound) {
				deferred.add(e.getKey());
			} else {
				load.addAll(fresh);
			}
		}
		return new Chunks(List.copyOf(load), deferred);
	}

	/** The plan: the JOIN crates, the deferred ones with their reason, the legacy fates, the resources to take at begin, the chunks to load. */
	public record Plan(List<CrateRead> join, Map<String, Defer> deferred, List<String> joined, List<String> finish, List<String> resources, List<Long> load,
		List<CrateRead> gone) {
	}

	/**
	 * Plans one {@code adoptCrates} call (Noah's decision 6: one txn per call). {@code reads} in candidate order (a crate two records name
	 * appears once: the first read wins); {@code credited} the ledger's credited keys; {@code paidChunks} per crate key the chunks its paid
	 * record reads; {@code records} per crate key the {@code site:} / {@code road:} / {@code group:} resources of the records naming it.
	 * Resources: {@code pile:<owner>}, then each JOIN crate's {@code crate:} resource, then its records', each once. A deferred crate and its
	 * records are in neither the plan nor the resources.
	 */
	public static Plan plan(String owner, List<CrateRead> reads, Predicate<String> credited, Map<String, ? extends Iterable<Long>> paidChunks,
		LongPredicate loaded, int bound, Map<String, List<String>> records) {
		Map<String, CrateRead> first = new LinkedHashMap<>();
		for (CrateRead r : reads) {
			first.putIfAbsent(r.key() + "@" + r.posKey(), r);
		}
		List<CrateRead> join = new ArrayList<>();
		Map<String, Defer> deferred = new LinkedHashMap<>();
		List<String> joined = new ArrayList<>();
		List<String> finish = new ArrayList<>();
		List<CrateRead> gone = new ArrayList<>();
		for (CrateRead r : first.values()) {
			Verdict v = classify(r, credited.test(r.adoptKey()));
			switch (v.fate()) {
				case JOIN -> join.add(r);
				case DEFER -> deferred.put(r.key(), v.why());
				case JOINED -> joined.add(r.key());
				case FINISH -> finish.add(r.key());
				case GONE -> gone.add(r);
			}
		}
		Map<String, Iterable<Long>> needs = new LinkedHashMap<>();
		for (CrateRead r : join) {
			Iterable<Long> n = paidChunks.get(r.key());
			needs.put(r.key(), n == null ? List.of() : n);
		}
		Chunks ch = chunks(needs, loaded, bound);
		List<CrateRead> kept = new ArrayList<>();
		for (CrateRead r : join) {
			if (ch.deferred().contains(r.key())) {
				deferred.put(r.key(), Defer.CHUNKS_UNLOADED);
			} else {
				kept.add(r);
			}
		}
		Set<String> res = new LinkedHashSet<>();
		res.add("pile:" + owner);
		kept.forEach(r -> res.add(r.resource()));
		gone.forEach(r -> res.add(r.resource())); // (T3b) its cell is restored inside the txn: held as a crate's
		for (CrateRead r : kept) {
			res.addAll(records.getOrDefault(r.key(), List.of()));
		}
		for (CrateRead r : gone) {
			res.addAll(records.getOrDefault(r.key(), List.of()));
		}
		return new Plan(List.copyOf(kept), deferred, joined, finish, List.copyOf(res), ch.load(), List.copyOf(gone));
	}
}
