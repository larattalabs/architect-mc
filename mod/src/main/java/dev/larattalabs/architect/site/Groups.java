package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.StageRules;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.placement.Occupancy;
import java.util.ArrayList;
import dev.larattalabs.architect.journal.JournalStore;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Set;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * Site groups at run time (docs/CONTRACT.md phase 4d "Site groups and undo", "Stages"): approving, skipping and reordering
 * stages, and taking a group's (or one stage's) sites down in reverse placement order under the per-tick budget. Instant
 * sites are restored over ticks ({@link RestoreJob}); construction sites deconstruct with refunds, one per tick. A player in
 * a box is waited for (up to 10 min); the player's things in a box stop the removal with the blockers. Server thread.
 */
public final class Groups {
	/** How long a removal waits for a player to step out of a box, in ticks. */
	static final long MAX_WAIT = 12_000;

	/** A removal in progress: the sites still to take down, last placed first. */
	static final class Removal {
		final String group;
		final @Nullable String stage;
		final List<String> sites = new ArrayList<>();
		final @Nullable String requester;
		final boolean force;
		Sites.Covered covered = Sites.Covered.KEEP;
		final List<String> cascaded = new ArrayList<>();
		Map<String, Integer> handedAll = new TreeMap<>();
		boolean started;
		@Nullable String current;
		long waited;
		long nextCheck;
		final Map<String, Integer> refund = new TreeMap<>();
		/** (T2b last round, group report P2) the owed keys its settles wrote (listed apart from the refund; this session's). */
		final List<String> owed = new ArrayList<>();
		final List<CompletableFuture<Removed>> futures = new ArrayList<>();
		/** (T4 final round) A member whose credit's save was refused: it stays until a confirmed save (retried); in memory (a restart resumes it). */
		transient @Nullable String creditWait;
		transient long creditRetryAt;
		/** (slice T4c) The region revision whose undo removes this stage, or null; persisted. */
		@Nullable Integer revisionId;
		/** (slice T4c) Its call answered held(decided) (decided, not done): it retries by itself and fires REMOVAL_FINISHED when done. */
		boolean heldDecided;
		/** (slice T4c) The tick of its next retry while held, and the wait before it (doubling). */
		transient long retryAt, backoff;
		/** Phase 4e: the undo group once planned (one undo over the sites), the sites it covers, and what it handed down. */
		@Nullable String undo;
		final List<String> undoSites = new ArrayList<>();
		Map<String, Integer> handed = new TreeMap<>();
		/**
		 * (fix/drain-holders) The undo group about to be committed (R2) and its sites, saved in the queue file before the commit is
		 * submitted: a stop after the commit reached the journal and before the queue file was saved again resumes R3/R4 under it (the
		 * journal decides: its entries UNDONE in that group), else plans again.
		 */
		@Nullable String planned;
		final List<String> plannedSites = new ArrayList<>();
		/**
		 * The queue save holding {@link #planned} (its generation, {@link Placement#save}), written before the commit is submitted (slice
		 * PSV: a confirmed write, not the saver's turn). 0: none this session (a loaded {@link #planned} is in the file already).
		 */
		transient long preSave;
		/** (PSV fix round, GPT P1 3) The confirmed queue write before the removal touches anything (fluids, custody, crate stock, tallies). */
		final transient Placement.Preflight preflight = new Placement.Preflight();
		/**
		 * (PSV fix round) A legacy crate's stock R1 took (prepareDeconstruct's crate path) per member, kept across a replan (the second
		 * prepareDeconstruct finds the crate gone) and saved: it drops with the member's deconstruct items, once. (slice PSVLC3, P1 1) Recorded
		 * and confirmed in the queue file before the take ({@link Groups#crateRecorded}); it counts only while the crate is gone: a crate that
		 * stands at R1 means the take never reached the disk, and its stock as it stands replaces what was carried ({@link Groups#withStock}).
		 */
		final Map<String, Map<String, Integer>> decStock = new LinkedHashMap<>();
		/** The cells the undo restores (its plan's stats). */
		int restoredCells;
		/** Phase 6a: CELL cells the undo left as they are (the world no longer held what the entry wrote: a player's block). */
		int keptCells;
		/** R1 in progress (not saved: a load plans again). */
		transient dev.larattalabs.architect.journal.WorldJournal.@Nullable UndoPlanner planner;
		transient List<String> planIds = List.of();
		transient @Nullable CompletableFuture<Object[]> txn;
		transient @Nullable String planGroup;
		transient @Nullable CompletableFuture<Void> commit;
		/** Phase 6a: how far the per-member checks got (they go over ticks). */
		transient int scan;
		transient int blockerScan;
		/** (DR-S) The save-first probe passed (this session): the world and ledger saved before anything of the removal changed the world. */
		transient boolean probed;
		/**
		 * (slice PSVLC3, P1 1) The queue save holding {@link #decStock} as recorded for this R1's crate takes (a standing legacy crate's stock,
		 * recorded before it is taken); R1 takes nothing until it is confirmed written. 0: none this session.
		 */
		transient long crateGen;
		/**
		 * (slice PSVLC3 fix round, GPT P1 1) R1 changed the world outside the journal (a crate taken, a player's holder replaced): the undo
		 * commits only after T0's barrier made it durable (OK). A refused or IN_DOUBT barrier (/save-off, a failed chunk write) keeps it waiting,
		 * retried every 5 s ({@link #barrierAt}). A load plans again (the world on disk decides what R1 finds).
		 */
		transient boolean worldPending;
		transient long barrierAt;
		/**
		 * (fix round, GPT P1 4) Per player holder in a region target's cell (key {@code cargo:<target>:<cell>}): its contents, held pending in the
		 * owner's ledger before the holder is replaced, and booked into the stock (past capacity) once the replacement is durable. Never item
		 * entities. A crash between: the start's settle books it when the holder is gone, drops it when the holder still holds its items.
		 */
		final transient Map<String, Credit> cargo = new LinkedHashMap<>();
		/** (fix round) The holders of {@link #cargo} were replaced (their contents only in the pending credits now). */
		transient boolean cargoApplied;
		/** Phase 6a: the sites outside the removal covering its cells, found off the server thread (it reads every section). */
		transient @Nullable CompletableFuture<java.util.LinkedHashSet<String>> outsideF;
		/** Construction members' deconstruct items (computed before the undo is planned, rule 7) and where they drop. */
		final Map<String, Map<String, Integer>> decItems = new LinkedHashMap<>();
		final Map<String, long[]> decAt = new LinkedHashMap<>();
		/**
		 * 6c Y: per stockpile member (a construction site or road drawing from its owner's stockpile), the refunds to credit once its
		 * restore is written: tallied before the undo (rule 7), saved apart from the items that drop, credited once per key.
		 */
		final Map<String, Credit> decCredit = new LinkedHashMap<>();
		/**
		 * (T2b part 2b) per crate-fed member, its {@code crate.settle} ({@link CrateSettle#stash}: its own crate, or its refunds alone), fixed
		 * before the undo and run once its restore is written; held, it stays here and runs again next tick (saved with the queue: a restart
		 * runs it, keyed, once).
		 */
		final Map<String, JsonObject> decSettle = new LinkedHashMap<>();
		/** (T2b part 2b) The group's shared crate's settle (its stock), once every member is written; null when none or done. */
		@Nullable JsonObject crateSettle;

		Removal(String group, @Nullable String stage, @Nullable String requester, boolean force) {
			this.group = group;
			this.stage = stage;
			this.requester = requester;
			this.force = force;
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("group", group);
			if (stage != null) {
				o.addProperty("stage", stage);
			}
			if (revisionId != null) {
				o.addProperty("revisionId", revisionId); // (slice T4c)
			}
			if (heldDecided) {
				o.addProperty("heldDecided", true);
			}
			JsonArray s = new JsonArray();
			sites.forEach(s::add);
			o.add("sites", s);
			if (requester != null) {
				o.addProperty("requester", requester);
			}
			o.addProperty("force", force);
			o.addProperty("covered", covered.name());
			o.addProperty("started", started);
			if (current != null) {
				o.addProperty("current", current);
			}
			o.addProperty("waited", waited);
			JsonObject r = new JsonObject();
			refund.forEach(r::addProperty);
			o.add("refund", r);
			// (F4) an undo whose R2 commit is not durable yet is saved as planned: the load asks the journal (resumeCommitted)
			boolean durable = undo != null && commit == null;
			if (planned != null || undo != null && !durable) {
				o.addProperty("planned", planned != null ? planned : undo);
				JsonArray ps = new JsonArray();
				(planned != null ? plannedSites : undoSites).forEach(ps::add);
				o.add("plannedSites", ps);
			}
			if (durable) {
				o.addProperty("undo", undo);
				JsonArray us = new JsonArray();
				undoSites.forEach(us::add);
				o.add("undoSites", us);
				JsonObject h = new JsonObject();
				handed.forEach(h::addProperty);
				o.add("handed", h);
				o.addProperty("restoredCells", restoredCells);
				o.addProperty("keptCells", keptCells);
			}
			if (!decItems.isEmpty()) {
				JsonObject d = new JsonObject();
				decItems.forEach((site, items) -> {
					JsonObject x = new JsonObject();
					JsonObject it = new JsonObject();
					items.forEach(it::addProperty);
					x.add("items", it);
					x.addProperty("at", decAt.get(site)[0]);
					d.add(site, x);
				});
				o.add("dec", d);
			}
			if (!decStock.isEmpty()) {
				JsonObject d = new JsonObject();
				decStock.forEach((site, items) -> {
					JsonObject it = new JsonObject();
					items.forEach(it::addProperty);
					d.add(site, it);
				});
				o.add("decStock", d);
			}
			if (!decCredit.isEmpty()) {
				JsonObject c = new JsonObject();
				decCredit.forEach((site, x) -> c.add(site, x.toJson()));
				o.add("credit", c);
			}
			if (!decSettle.isEmpty()) {
				JsonObject c = new JsonObject();
				decSettle.forEach(c::add);
				o.add("settle", c);
			}
			if (!owed.isEmpty()) {
				com.google.gson.JsonArray ow = new com.google.gson.JsonArray(); // (T4b, finding 5) the owed keys its settles wrote, across a restart
				owed.forEach(ow::add);
				o.add("owed", ow);
			}
			if (crateSettle != null) {
				o.add("crateSettle", crateSettle);
			}
			return o;
		}

		static Removal fromJson(JsonObject o) {
			Removal r = new Removal(o.get("group").getAsString(), o.has("stage") ? o.get("stage").getAsString() : null,
				o.has("requester") ? o.get("requester").getAsString() : null, o.get("force").getAsBoolean());
			o.getAsJsonArray("sites").forEach(e -> r.sites.add(e.getAsString()));
			r.started = o.get("started").getAsBoolean();
			r.revisionId = o.has("revisionId") ? o.get("revisionId").getAsInt() : null; // (slice T4c)
			r.heldDecided = o.has("heldDecided") && o.get("heldDecided").getAsBoolean();
			r.covered = o.has("covered") ? Sites.Covered.valueOf(o.get("covered").getAsString()) : Sites.Covered.KEEP;
			r.current = o.has("current") ? o.get("current").getAsString() : null;
			r.waited = o.get("waited").getAsLong();
			o.getAsJsonObject("refund").entrySet().forEach(e -> r.refund.put(e.getKey(), e.getValue().getAsInt()));
			if (o.has("planned")) {
				r.planned = o.get("planned").getAsString();
				o.getAsJsonArray("plannedSites").forEach(e -> r.plannedSites.add(e.getAsString()));
			}
			if (o.has("undo")) {
				r.undo = o.get("undo").getAsString();
				o.getAsJsonArray("undoSites").forEach(e -> r.undoSites.add(e.getAsString()));
				o.getAsJsonObject("handed").entrySet().forEach(e -> r.handed.put(e.getKey(), e.getValue().getAsInt()));
				r.restoredCells = o.has("restoredCells") ? o.get("restoredCells").getAsInt() : 0;
				r.keptCells = o.has("keptCells") ? o.get("keptCells").getAsInt() : 0;
				if (!undoCommitted(r.undo)) {
					// (F4) a queue file naming an undo group the journal never got (written before toJson saved a pending commit as planned):
					// as planned, so the journal decides (resumeCommitted: planned again)
					Architect.LOGGER.info("Group removal {}: its undo {} is in no journal entry; the journal decides on resuming", r.group, r.undo);
					r.planned = r.undo;
					r.plannedSites.clear();
					r.plannedSites.addAll(r.undoSites);
					r.undo = null;
					r.undoSites.clear();
					r.handed = new TreeMap<>();
					r.restoredCells = 0;
					r.keptCells = 0;
				}
			}
			if (o.has("decStock")) {
				// (T4a fix round) PSV's crate-stock carriage is inert on this base (nothing is taken at prepare since T2b, so no queue this build
				// writes holds one): an imported decStock is ignored, never carried into a deconstruct (it would count a crate's stock twice)
				Architect.LOGGER.warn("Removal of group {}: its queue entry carries a legacy decStock {}; ignored (T2b settles crates after the restore)",
					r.group, o.get("decStock"));
			}
			if (o.has("dec")) {
				o.getAsJsonObject("dec").entrySet().forEach(e -> {
					JsonObject x = e.getValue().getAsJsonObject();
					Map<String, Integer> items = new TreeMap<>();
					x.getAsJsonObject("items").entrySet().forEach(i -> items.put(i.getKey(), i.getValue().getAsInt()));
					r.decItems.put(e.getKey(), items);
					r.decAt.put(e.getKey(), new long[] {x.get("at").getAsLong()});
				});
			}
			if (o.has("settle")) {
				o.getAsJsonObject("settle").entrySet().forEach(e -> r.decSettle.put(e.getKey(), e.getValue().getAsJsonObject()));
			}
			if (o.get("owed") instanceof com.google.gson.JsonArray ow) {
				ow.forEach(e -> r.owed.add(e.getAsString()));
			}
			if (o.has("crateSettle") && o.get("crateSettle").isJsonObject()) {
				r.crateSettle = o.getAsJsonObject("crateSettle");
			}
			if (o.has("credit")) {
				o.getAsJsonObject("credit").entrySet().forEach(e -> r.decCredit.put(e.getKey(), Credit.fromJson(e.getValue().getAsJsonObject())));
			}
			return r;
		}

		/** Whether undo group {@code undo} reached the world journal (any entry of it, undone or settled since but kept). */
		static boolean undoCommitted(String undo) {
			var js = dev.larattalabs.architect.journal.WorldJournal.storeOrNull();
			return js != null && !js.find(m -> undo.equals(m.undoGroup())).isEmpty();
		}
	}

	/** 6c Y: a stockpile member's refunds, to credit into {@code owner}'s stockpile under {@code key} once its restore is written. */
	record Credit(String owner, String key, Map<String, Integer> items, long at) {
		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("owner", owner);
			o.addProperty("key", key);
			JsonObject it = new JsonObject();
			items.forEach(it::addProperty);
			o.add("items", it);
			o.addProperty("at", at);
			return o;
		}

		static Credit fromJson(JsonObject o) {
			Map<String, Integer> items = new TreeMap<>();
			o.getAsJsonObject("items").entrySet().forEach(i -> items.put(i.getKey(), i.getValue().getAsInt()));
			return new Credit(o.get("owner").getAsString(), o.get("key").getAsString(), items, o.get("at").getAsLong());
		}
	}

	/** 6c Y: credits a member's stockpile refunds (once per key); what was credited joins the removal's refund. */
	private static void credit(MinecraftServer server, Removal r, String id) {
		Credit c = r.decCredit.get(id);
		if (c == null) {
			return;
		}
		Stockpiles.Pile p = Stockpiles.get(c.owner());
		ServerLevel level = p != null ? Sites.levelOf(server, p.dimension()) : Sites.levelOf(server, dimensionOf(id));
		if (level == null) {
			return;
		}
		boolean already = p != null && p.ledger().credited(c.key());
		Map<String, Integer> held = p == null ? Map.of() : p.ledger().custody(c.key()); // (M5 FK) the declared containers' contents
		if (!held.isEmpty() && !already) {
			dev.larattalabs.architect.journal.WorldJournal.kill("FKC2"); // (TEST) the restore written, the custody's credit not yet
		}
		Builder.creditRefund(level, c.owner(), c.key(), c.items(), BlockPos.of(c.at()), null);
		if (!already) {
			c.items().forEach((k, v) -> r.refund.merge(k, v, Integer::sum));
			held.forEach((k, v) -> r.refund.merge(k, v, Integer::sum));
			// (slice PS, audit N1) the credit is saved with the world (players, the restored chunks flushed, the ledger) before the caller
			// drops the member from the saved removal (and end() drops the removal, its decCredit with it): a crash after that point finds the
			// refund in the saved ledger, never the building gone and its refund gone. Before it, the removal resumes and credits the key
			// again (once per key: the saved ledger hasn't it).
			Stockpiles.saveCredit(server);
		}
	}

	/** What a removal ended with: removed, or stopped at a site with its blockers; every refund so far. */
	public record Removed(boolean removed, List<String> blockers, Map<String, Integer> refund, int restored, Map<String, Integer> handedDown,
		List<String> cascaded, int kept, dev.larattalabs.architect.api.@Nullable RemovalStopCause cause, List<String> owed) {
		/** The S-DRS-1 shape (no owed keys). */
		public Removed(boolean removed, List<String> blockers, Map<String, Integer> refund, int restored, Map<String, Integer> handedDown,
			List<String> cascaded, int kept, dev.larattalabs.architect.api.@Nullable RemovalStopCause cause) {
			this(removed, blockers, refund, restored, handedDown, cascaded, kept, cause, List.of());
		}

		public Removed(boolean removed, List<String> blockers, Map<String, Integer> refund) {
			this(removed, blockers, refund, 0, Map.of(), List.of(), 0, null);
		}

		public Removed(boolean removed, List<String> blockers, Map<String, Integer> refund, int restored, Map<String, Integer> handedDown,
			List<String> cascaded, int kept) {
			this(removed, blockers, refund, restored, handedDown, cascaded, kept, null);
		}

		/** (S-DRS-1) A stop with its typed cause (the blocker text as before). */
		public Removed(String blocker, Map<String, Integer> refund, dev.larattalabs.architect.api.RemovalStopCause cause) {
			this(false, List.of(blocker), refund, 0, Map.of(), List.of(), 0, cause);
		}

		/** (S-DRS-1) The typed cause of a stop: {@code cause}, or OTHER when it has none; null when removed. */
		public dev.larattalabs.architect.api.@Nullable RemovalStopCause stopCause() {
			return removed ? null : cause == null ? dev.larattalabs.architect.api.RemovalStopCause.OTHER : cause;
		}

		/** (S-DRS-1) A refused save before anything changed: the text Steward parses today, unchanged. */
		static Removed saveRefused(String group, String why, Map<String, Integer> refund) {
			return new Removed("the removal of group " + group + " was not started: " + why, refund, dev.larattalabs.architect.api.RemovalStopCause.SAVE_REFUSED);
		}

		/** (S-DRS-1) A player stayed in a member's box past the wait (or a member is still being placed: OTHER). */
		static Removed waitedOut(String id, boolean player, Map<String, Integer> refund) {
			return new Removed(player ? "a player stayed in " + id + " for 10 minutes" : id + " is still being placed", refund, player
				? dev.larattalabs.architect.api.RemovalStopCause.PLAYER_IN_BOX : dev.larattalabs.architect.api.RemovalStopCause.OTHER);
		}

		/** (S-DRS-1) Covering sites outside the removal, refused. */
		static Removed covered(java.util.Collection<String> outside, Map<String, Integer> refund) {
			return new Removed("COVERED: " + String.join(", ", outside) + " cover cells of the sites", refund, dev.larattalabs.architect.api.RemovalStopCause.COVERED);
		}

		/** (S-DRS-1) A member's blockers: the owner's things in its box ({@code cargo} false) or a filled container's cargo. */
		static Removed blocked(String id, List<String> blockers, boolean cargo, Map<String, Integer> refund) {
			return new Removed(Sites.blockersMessage(id, blockers), refund, cargo ? dev.larattalabs.architect.api.RemovalStopCause.CARGO
				: dev.larattalabs.architect.api.RemovalStopCause.THINGS_IN_BOX);
		}

		public Removed(boolean removed, List<String> blockers, Map<String, Integer> refund, int restored, Map<String, Integer> handedDown,
			List<String> cascaded) {
			this(removed, blockers, refund, restored, handedDown, cascaded, 0);
		}
	}

	private static final RemovalSeal.Counted<Removal> REMOVALS = new RemovalSeal.Counted<>();
	/** (6c X, C22) Removals that stopped with restorations unfinished (their undo committed): a retry resumes them, it never starts over. */
	private static final RemovalSeal.Counted<Removal> STALLED = new RemovalSeal.Counted<>();

	/** (slice LC3) The removals lists' structural changes so far. */
	static int sealMods() {
		int h = REMOVALS.mods() * 31 + STALLED.mods();
		for (List<Removal> l : List.of(REMOVALS, STALLED)) {
			for (Removal r : l) {
				h = h * 31 + r.sites.size() * 2 + (r.current != null ? 1 : 0); // a member written leaves the list (or current)
				h = h * 31 + r.undoSites.hashCode() * 17 + r.plannedSites.hashCode(); // (the whole member set, refilled at a commit or a reload)
			}
		}
		return h;
	}

	/**
	 * (slice LC3) The ids a group or stage removal seals: running or stalled (a retry resumes it with no new blocker scan), its members not
	 * yet written and the one being written, and (LC3 fix, review 2) its members already written too, its whole undo set (or the planned
	 * set before the commit): crash recovery can still write a written member again ({@link #writeAgainIn}) until the removal leaves the
	 * queue, so none unseals before the removal ends. All of it is in the queue file.
	 */
	static void sealedIds(List<String> out) {
		for (List<Removal> l : List.of(REMOVALS, STALLED)) {
			for (Removal r : l) {
				out.addAll(r.sites);
				if (r.current != null) {
					out.add(r.current);
				}
				out.addAll(r.undoSites);
				out.addAll(r.plannedSites);
			}
		}
	}

	private static @Nullable Removal stalled(String group, @Nullable String stage) {
		for (Removal r : STALLED) {
			if (r.group.equals(group) && java.util.Objects.equals(r.stage, stage)) {
				return r;
			}
		}
		return null;
	}

	/**
	 * (slice PSVLC3, P1 2) Why a removal of {@code group} ({@code stage} null: the whole group) can't start while another removal of the group
	 * is stalled, or null. A stalled removal holds what only its own retry settles (a crate stock carried before its undo, restorations still
	 * pending, its members sealed); a second removal over the same members would take them past it, and the stalled one's retry would never
	 * find them again (adef7f9b: a whole-group removal over a stalled stage left the stage UNDONE and its carried stock unreachable).
	 */
	static @Nullable String stageRunningRefusal(String group) {
		for (Removal x : REMOVALS) {
			if (x.group.equals(group) && x.stage != null) {
				return "the undo of stage " + x.stage + " of group " + group + " is in progress; remove the group once it ends";
			}
		}
		return null;
	}

	/**
	 * (fix round, GPT P1 3) The ops way out of a stalled removal that another stalled removal of its group blocks (only a queue file from
	 * before this admission rule can hold two): resumes the named one as a retry does, past {@link #stalledRefusal}. Answers why not, or null
	 * when it was resumed. Server thread.
	 */
	public static @Nullable String resumeStalled(MinecraftServer server, String group, @Nullable String stage) {
		if (Placement.loadFailed()) {
			return UNRECORDABLE;
		}
		for (Removal r : REMOVALS) {
			if (r.group.equals(group)) {
				return "a removal of group " + group + " is in progress";
			}
		}
		Removal st = stalled(group, stage);
		if (st == null) {
			return "no stalled " + (stage == null ? "removal of group " + group : "undo of stage " + stage + " of group " + group);
		}
		Architect.LOGGER.warn("Removal of group {}{}: resumed by an operator", group, stage == null ? "" : " stage " + stage);
		resume(st, new CompletableFuture<>());
		Placement.save(server, false);
		return null;
	}

	static @Nullable String stalledRefusal(String group, @Nullable String stage) {
		for (Removal x : STALLED) {
			if (x.group.equals(group) && !java.util.Objects.equals(x.stage, stage)) {
				String what = x.stage == null ? "the removal of group " + group : "the undo of stage " + x.stage + " of group " + group;
				return what + " is stalled (it holds what only its retry settles); retry " + (x.stage == null ? "the group's removal" : "that stage's undo")
					+ " first";
			}
		}
		return null;
	}

	// ------------------------------------------------------------------ (slice LC3 fix 2) a stalled removal (dev.seal.state)

	/** (LC3 fix 2) A stalled removal's members: written (its restore done) and unwritten (still to write, the one that broke included). */
	record Settle(List<String> written, List<String> unwritten) {
	}

	/** (pure) {@code r}'s members by whether their restore was written: its committed undo set, those left in its sites unwritten. */
	static Settle settle(Removal r) {
		List<String> written = new ArrayList<>();
		List<String> unwritten = new ArrayList<>();
		for (String id : r.undoSites) {
			(r.sites.contains(id) || id.equals(r.current) ? unwritten : written).add(id);
		}
		return new Settle(List.copyOf(written), List.copyOf(unwritten));
	}

	/** (TEST, {@code dev.seal.state}) The stalled removals: group, stage, members written and not. */
	static void stalledJson(JsonArray out) {
		for (Removal r : STALLED) {
			JsonObject o = new JsonObject();
			o.addProperty("group", r.group);
			if (r.stage != null) {
				o.addProperty("stage", r.stage);
			}
			Settle st = settle(r);
			JsonArray w = new JsonArray();
			st.written().forEach(w::add);
			JsonArray u = new JsonArray();
			st.unwritten().forEach(u::add);
			o.add("written", w);
			o.add("unwritten", u);
			if (r.current != null) {
				o.addProperty("current", r.current); // (LC3 round 4) the member whose restore broke (among the unwritten)
			}
			out.add(o);
		}
	}

	/** A retry takes over a stalled removal: its undo and remaining members, a fresh future. */
	private static Removal resume(Removal r, CompletableFuture<Removed> f) {
		STALLED.remove(r);
		r.futures.clear();
		r.futures.add(f);
		r.current = null;
		r.waited = 0;
		r.nextCheck = 0;
		r.started = true;
		// (slice PSVLC3, P1 3) a removal that stalled before its undo checks its members again: a player who entered a box meanwhile is waited
		// for, a blocker placed meanwhile refuses it, the covering sites are found again, and the queue write and save-first probe come first
		r.scan = 0;
		r.blockerScan = 0;
		r.outsideF = null;
		r.preflight.gen = 0;
		r.probed = false;
		r.crateGen = 0;
		r.barrierAt = 0;
		REMOVALS.add(r);
		return r;
	}
	private static long tick;

	/**
	 * (C23) Called on the server thread when a whole-group removal ends (not a stage undo), with the group id and the result,
	 * before the removal's futures complete. A removal resumed after a load has no future of its own (its callers' futures failed
	 * at the stop), so whatever depends on the end (a region's REMOVED/PARTIAL state) hangs here, keyed by the group id, not on a
	 * future. The early answer for an already removed group calls it too; a refusal (the owner rule, no such group) does not:
	 * it ends no removal (one may be running for another caller), so the caller handles its own refusal.
	 */
	public static volatile java.util.function.@Nullable BiConsumer<String, Removed> GROUP_ENDED;

	/**
	 * (6c D3, Steward's RC) The groups whose last whole-group removal ended not removed and having written nothing: its undo never
	 * planned or committed, no member's restore begun, no fluid drained (a stop on a blocker before it starts: a player in a box past
	 * the wait, the owner's things in a box, covered cells refused, the journal unreadable). Read by the region's end (its state stays as
	 * it was) through {@link #endedUntouched}; set in {@link #end} before {@link #GROUP_ENDED} is called.
	 */
	private static final Set<String> UNTOUCHED = java.util.concurrent.ConcurrentHashMap.newKeySet();

	/** (S-DRS-1) How a group's last whole-group removal stopped and why, typed (SiteGroup.removalStop, removalStopCause). */
	public record Stop(dev.larattalabs.architect.api.RemovalStop stop, dev.larattalabs.architect.api.RemovalStopCause cause) {
	}

	/** (S-DRS-1) The last stop per group (in memory, as {@link #UNTOUCHED}); a removal that removes the group clears it. */
	private static final Map<String, Stop> LAST_STOP = new java.util.concurrent.ConcurrentHashMap<>();

	/** (S-DRS-1) The group's last whole-group removal's stop, or null. */
	public static @Nullable Stop lastStop(String groupId) {
		return LAST_STOP.get(groupId);
	}

	/**
	 * (8b review P2-5) A whole-group removal ended (removed, stopped, refused part-way or timed out): its owner's settlement changed (its
	 * sites read removing no longer), as its start signalled.
	 */
	static void signalEnd(@Nullable String owner, String groupId) {
		dev.larattalabs.architect.apiimpl.SettlementSignals.mark(owner, dev.larattalabs.architect.apiimpl.Views.regionOfGroupPublic(groupId));
	}

	/** (S-DRS-1) The stop a whole-group removal's end records: null when it removed the group. Pure. */
	static @Nullable Stop stopOf(Removed result, boolean untouched) {
		return result.removed() ? null : new Stop(untouched ? dev.larattalabs.architect.api.RemovalStop.NOT_STARTED : dev.larattalabs.architect.api.RemovalStop.PARTIAL,
			result.stopCause());
	}

	/** Whether the group's last whole-group removal ended having written nothing (see {@link #UNTOUCHED}). Server thread. */
	public static boolean endedUntouched(String groupId) {
		return UNTOUCHED.contains(groupId);
	}

	private static void groupEnded(String group, Removed result) {
		var h = GROUP_ENDED;
		if (h != null) {
			try {
				h.accept(group, result);
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Group {}: the removal's end listener failed", group, e);
			}
		}
	}

	/** (6d RV) Whether a removal of this group's stage {@code stage} is in progress (running, not stalled). */
	public static boolean stageRemovalRunning(String groupId, String stage) {
		for (Removal r : REMOVALS) {
			if (r.group.equals(groupId) && stage.equals(r.stage)) {
				return true;
			}
		}
		for (Removal r : STALLED) {
			if (r.heldDecided && r.group.equals(groupId) && stage.equals(r.stage)) {
				return true; // (slice T4c) held (decided): it goes on by itself; the revision's undo waits for it
			}
		}
		return false;
	}

	/**
	 * (6d RV) An UNDONE stage some of whose members stand again (a stop lost its restore's writes and the load's sites check brought their
	 * records back: "it stands again"): the stage reads PLACED again so that its undo runs again. Answers the members standing. Server thread.
	 */
	public static List<String> standingAgain(MinecraftServer server, String groupId, String stage) {
		SiteGroupRec g = Sites.group(groupId);
		SiteGroupRec.StageRec st = g == null ? null : g.stage(stage);
		if (st == null || st.state() != Stage.State.UNDONE) {
			return List.of();
		}
		List<String> standing = new ArrayList<>();
		for (String id : st.sites()) {
			if (Sites.get(id) != null || Infras.get(id) != null) {
				standing.add(id);
			}
		}
		if (!standing.isEmpty()) {
			Architect.LOGGER.warn("Group {}: stage {} was undone but {} stand again after a stop: its undo runs again", groupId, stage, standing);
			Batches.setStage(server, g, stage, Stage.State.PLACED);
		}
		return standing;
	}

	/** (C23) Whether a whole-group removal of this group is in progress (not a stalled one). */
	public static boolean removalRunning(String groupId) {
		for (Removal r : REMOVALS) {
			if (r.group.equals(groupId) && r.stage == null) {
				return true;
			}
		}
		return false;
	}

	/** DevBridge {@code dev.undo.failRestore} (6c X, C22): break the removal restore after {@code skip} finished ones (-1: off). */
	public static void failRestore(int skip) {
		RestoreJob.failSkip = skip;
	}


	private Groups() {
	}

	static boolean anyRemoving() {
		return !REMOVALS.isEmpty();
	}

	// ------------------------------------------------------------------ stages

	private static SiteGroupRec require(String groupId) {
		SiteGroupRec g = Sites.group(groupId);
		if (g == null) {
			throw new IllegalArgumentException("no site group " + groupId);
		}
		return g;
	}

	private static SiteGroupRec.StageRec requireStage(SiteGroupRec g, String stage) {
		SiteGroupRec.StageRec st = g.stage(stage);
		if (st == null) {
			throw new IllegalArgumentException("group " + g.id() + " has no stage " + stage + " (it has " + g.stageNames() + ")");
		}
		return st;
	}

	/** Approves a planned stage. Server thread. */
	public static SiteGroupRec.StageRec approve(MinecraftServer server, String groupId, String stage) {
		SiteGroupRec g = require(groupId);
		SiteGroupRec.StageRec st = requireStage(g, stage);
		Batches.setStage(server, g, stage, StageRules.approve(st.state()));
		return Sites.group(groupId).stage(stage);
	}

	/** Skips a stage that has not started placing: its items fail CANCELLED. Server thread. */
	public static SiteGroupRec.StageRec skip(MinecraftServer server, String groupId, String stage) {
		SiteGroupRec g = require(groupId);
		SiteGroupRec.StageRec st = requireStage(g, stage);
		Batches.setStage(server, g, stage, StageRules.skip(st.state()));
		Batches.skipped(server, st.batchId(), stage);
		return Sites.group(groupId).stage(stage);
	}

	/** Reorders the planned stages (see {@link StageRules#reorder}). Server thread. */
	public static SiteGroupRec reorder(MinecraftServer server, String groupId, List<String> planned) {
		SiteGroupRec g = require(groupId);
		List<String> order = StageRules.reorder(g.stageNames(), g.stageStates(), planned);
		Map<String, SiteGroupRec.StageRec> by = new LinkedHashMap<>();
		g.stages().forEach(s -> by.put(s.name(), s));
		SiteGroupRec n = g.withStages(order.stream().map(by::get).toList());
		Sites.putGroup(server, n);
		Architect.LOGGER.info("Group {}: stages reordered to {}", groupId, order);
		return n;
	}

	// ------------------------------------------------------------------ removal

	/**
	 * Takes a whole group down (its running batches cancelled first), last placed first. The owner rule: another owner's
	 * group needs {@code force}. Server thread.
	 */
	public static CompletableFuture<Removed> removeGroup(MinecraftServer server, String groupId, @Nullable String requester, boolean force) {
		return removeGroup(server, groupId, requester, force, Sites.Covered.KEEP);
	}

	/** {@link #removeGroup} with a covered policy for cells of its sites that sites outside the group cover (phase 4e). */
	public static CompletableFuture<Removed> removeGroup(MinecraftServer server, String groupId, @Nullable String requester, boolean force,
		Sites.Covered covered) {
		SiteGroupRec g = Sites.group(groupId);
		if (g == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no site group " + groupId));
		}
		String owner = ApiRules.removeRefusal(groupId, g.owner(), requester, force);
		if (owner != null) {
			// (C23) not the hook: a refused caller (another requester) must not end a removal that keeps running
			return CompletableFuture.completedFuture(new Removed(false, List.of(owner), Map.of()));
		}
		if (Placement.loadFailed()) {
			// (PSV fix round, GPT P1 2) nothing touched: no batch cancelled, no state, no custody or crate stock taken
			return CompletableFuture.completedFuture(new Removed(false, List.of(UNRECORDABLE), Map.of()));
		}
		String other = stalledRefusal(groupId, null);
		if (other != null) {
			// (slice PSVLC3, P1 2) a stalled stage removal holds what only its own retry can settle: refused before anything is touched
			return CompletableFuture.completedFuture(new Removed(false, List.of(other), Map.of()));
		}
		// (6c X, C22) a group this world already removed: removed again, nothing written (its tombstone keeps the time)
		if (SiteGroupRec.REMOVED.equals(g.state()) && stalled(groupId, null) == null && REMOVALS.stream().noneMatch(x -> x.group.equals(groupId))) {
			Removed yes = new Removed(true, List.of(), Map.of());
			groupEnded(groupId, yes);
			return CompletableFuture.completedFuture(yes);
		}
		for (Removal r : REMOVALS) {
			if (r.group.equals(groupId) && r.stage == null) {
				CompletableFuture<Removed> f = new CompletableFuture<>();
				r.futures.add(f);
				return f;
			}
		}
		String running = stageRunningRefusal(groupId);
		if (running != null) {
			// (slice PSVLC3 fix round, GPT P1 3) one removal of a group at a time: a stage undo in progress is not joined by a whole-group removal
			return CompletableFuture.completedFuture(new Removed(false, List.of(running), Map.of()));
		}
		for (QBatch b : Batches.all()) {
			if (b.group.equals(groupId) && b.running()) {
				Batches.cancel(server, b.id);
			}
		}
		Sites.putGroup(server, g.withState(SiteGroupRec.REMOVING));
		CompletableFuture<Removed> f = new CompletableFuture<>();
		Removal st = stalled(groupId, null);
		if (st != null) {
			resume(st, f);
			Placement.save(server, false);
			Architect.LOGGER.info("Removing group {}: resuming the earlier removal ({} site(s) left to restore)", groupId, st.sites.size());
			return f;
		}
		Removal r = new Removal(groupId, null, requester, force);
		r.covered = covered;
		r.futures.add(f);
		REMOVALS.add(r);
		Placement.save(server, false);
		Architect.LOGGER.info("Removing group {} ({} site(s))", groupId, g.sites().size());
		// (8b EV) its sites read removing from now: a status edge
		dev.larattalabs.architect.apiimpl.SettlementSignals.mark(g.owner(), dev.larattalabs.architect.apiimpl.Views.regionOfGroupPublic(groupId));
		return f;
	}

	/**
	 * (PSV fix round, GPT P1 2) Why a removal is refused when the queue file failed to load this session: nothing is saved over that file, so
	 * no undo can be recorded; refused before anything is touched.
	 */
	public static final String UNRECORDABLE = "the queue file (" + Placement.FILE + ") failed to load this session: an undo can't be recorded, so nothing is "
		+ "removed; fix or restore the file and reopen the world";

	/** Undoes a placed (or partial) stage: its sites, last placed first; then the stage is UNDONE. Server thread. */
	public static CompletableFuture<Removed> undoStage(MinecraftServer server, String groupId, String stage, boolean force) {
		return undoStage(server, groupId, stage, force, Sites.Covered.KEEP);
	}

	/** {@link #undoStage} with a covered policy (phase 4e). */
	public static CompletableFuture<Removed> undoStage(MinecraftServer server, String groupId, String stage, boolean force, Sites.Covered covered) {
		return undoStage(server, groupId, stage, force, covered, false);
	}

	/**
	 * (PX, XR guard) {@link #undoStage} for a caller that owns the stage: a region's revision undoing its own additive stage
	 * ({@code ownStage}; a revision's cells never sit over a block the region paid for, TileCheck survival_paid). Everyone else
	 * (the API, the command) is refused on a survival region's group, see {@link #undoStageRefusal}.
	 */
	public static CompletableFuture<Removed> undoStage(MinecraftServer server, String groupId, String stage, boolean force, Sites.Covered covered,
		boolean ownStage) {
		return undoStage(server, groupId, stage, force, covered, ownStage, null);
	}

	/** (slice T4c) {@link #undoStage} for a region revision's undo ({@code revisionId}): REMOVAL_FINISHED names the revision. */
	public static CompletableFuture<Removed> undoStage(MinecraftServer server, String groupId, String stage, boolean force, Sites.Covered covered,
		boolean ownStage, @Nullable Integer revisionId) {
		SiteGroupRec g = Sites.group(groupId);
		if (g == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no site group " + groupId));
		}
		String guard = undoStageRefusal(g, stage, ownStage, id -> {
			var l = dev.larattalabs.architect.region.RegionsImpl.live(id);
			return l != null && l.rec().survival();
		});
		if (guard != null) {
			return CompletableFuture.failedFuture(new IllegalStateException(guard));
		}
		if (Placement.loadFailed()) {
			return CompletableFuture.failedFuture(new IllegalStateException(UNRECORDABLE)); // (PSV fix round) before anything is touched
		}
		for (Removal r : REMOVALS) {
			if (r.group.equals(groupId)) {
				return CompletableFuture.failedFuture(new IllegalStateException("group " + groupId + " is already being taken down"));
			}
		}
		String other = stalledRefusal(groupId, stage);
		if (other != null) {
			return CompletableFuture.failedFuture(new IllegalStateException(other)); // (slice PSVLC3, P1 2)
		}
		// (slice PSVLC3, P1 2) a stalled undo of this stage is retried before the stage's state is judged: it was admitted when it started, and
		// only its retry settles what it holds (a carried crate stock, restorations still pending)
		Removal st = stalled(groupId, stage);
		if (st != null) {
			CompletableFuture<Removed> f = new CompletableFuture<>();
			resume(st, f);
			Placement.save(server, false);
			return f;
		}
		int i = g.stageIndex(stage);
		if (i < 0) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("group " + groupId + " has no stage " + stage));
		}
		String no = StageRules.undoRefusal(g.stageNames(), g.stageStates(), i, force);
		if (no != null) {
			return CompletableFuture.failedFuture(new IllegalStateException(no));
		}
		if (g.stages().get(i).sites().stream().anyMatch(x -> x.startsWith(Batches.DELTA_TOKEN))) {
			return undoDeltaStage(server, g, stage, g.stages().get(i).sites(), force);
		}
		Removal r = new Removal(groupId, stage, null, true);
		r.covered = covered;
		r.started = true;
		r.revisionId = revisionId;
		List<String> sites = new ArrayList<>(g.stages().get(i).sites());
		java.util.Collections.reverse(sites);
		r.sites.addAll(sites);
		CompletableFuture<Removed> f = new CompletableFuture<>();
		r.futures.add(f);
		REMOVALS.add(r);
		Placement.save(server, false);
		Architect.LOGGER.info("Undoing stage {} of group {} ({} site(s)){}", stage, groupId, sites.size(), force ? " (forced)" : "");
		return f;
	}

	/**
	 * (PX) The refusal for undoing one stage of a survival region's group, or null. A later writer of the region that took up an earlier
	 * writer's paid block gave its items back to the stockpile (XR); undoing the later stage writes the block back for free and the
	 * earlier writer owns it again, so the items would exist twice. No Regions path does it; this refuses it for a direct caller.
	 * {@code survivalRegion} says whether a region id is a survival region's.
	 */
	static @Nullable String undoStageRefusal(SiteGroupRec g, String stage, boolean ownStage, java.util.function.Predicate<String> survivalRegion) {
		if (ownStage || !g.ext().has(RegionItems.EXT_REGION)) {
			return null;
		}
		String region = g.ext().get(RegionItems.EXT_REGION).getAsString();
		if (!survivalRegion.test(region)) {
			return null;
		}
		return "stage " + stage + " of group " + g.id() + " belongs to survival region " + region + ": a stage of a survival region is not undone on its own"
			+ " (a block a later writer took up would come back for free); remove the region, or undo a revision of it";
	}

	/**
	 * The undo of a stage of delta items (phase 5b, e.g. Steward's "upgrade"): each delta reverted, newest first. Each must be its
	 * site's top delta: a later delta on the same site refuses without {@code force} (4d's dependency rule), and {@code force}
	 * reverts the later deltas too. In survival (INSTANT not allowed) each becomes a forward construction delta to the version
	 * before it. Checked for every delta before anything is written.
	 */
	static CompletableFuture<Removed> undoDeltaStage(MinecraftServer server, SiteGroupRec g, String stage, List<String> tokens, boolean force) {
		List<String[]> ds = new ArrayList<>();
		for (String t : tokens) {
			if (t.startsWith(Batches.DELTA_TOKEN)) {
				String[] p = t.substring(Batches.DELTA_TOKEN.length()).split(":", 2);
				if (p.length == 2) {
					ds.add(p);
				}
			}
		}
		java.util.Collections.reverse(ds);
		boolean instant = !dev.larattalabs.architect.survival.SurvivalWorld.on();
		// the checks first: each delta standing and on top (or force)
		Set<String> stageEntries = new HashSet<>();
		ds.forEach(d -> stageEntries.add(d[1]));
		for (String[] d : ds) {
			List<String> active = SiteJournal.active(d[0]).stream().filter(m -> m.kind().equals(dev.larattalabs.architect.journal.WorldJournal.DELTA))
				.sorted(java.util.Comparator.comparingLong(JournalStore.Meta::layer)).map(JournalStore.Meta::id).toList();
			int at = active.indexOf(d[1]);
			if (at >= 0 && !force) {
				for (String later : active.subList(at + 1, active.size())) {
					if (!stageEntries.contains(later)) {
						return CompletableFuture.failedFuture(new IllegalStateException(d[0] + " has a later update (" + later + ") that is not in stage "
							+ stage + "; undo it first, or pass force"));
					}
				}
			}
		}
		List<String> notes = new ArrayList<>();
		Map<String, Integer> refund = new LinkedHashMap<>();
		boolean ok = true;
		for (String[] d : ds) {
			Site b = Sites.get(d[0]);
			ServerLevel level = b == null ? null : Sites.levelOf(server, b);
			if (level == null) {
				notes.add(d[0] + " is gone");
				continue;
			}
			try {
				SiteDeltas.Result r;
				if (instant) {
					r = SiteDeltas.revertDelta(level, d[0], d[1], true);
				} else {
					int to = fromOf(d[1]);
					r = Builder.applyConstructionDelta(level, new SiteDeltas.Request(d[0], to, dev.larattalabs.architect.delta.DeltaPlanner.Edits.KEEP, false,
						b.owner(), true), null);
				}
				notes.addAll(r.notes());
				r.refund().forEach((k, v) -> refund.merge(k, v, Integer::sum));
			} catch (Sites.SiteException e) {
				ok = false;
				notes.add(d[0] + ": " + e.getMessage());
			}
		}
		SiteGroupRec n = Sites.group(g.id());
		if (ok && n != null) {
			Batches.setStage(server, n, stage, Stage.State.UNDONE);
		}
		Architect.LOGGER.info("Undo of delta stage {} of group {}: {}", stage, g.id(), ok ? "done" : String.join("; ", notes));
		return CompletableFuture.completedFuture(new Removed(ok, ok ? List.of() : notes, refund));
	}

	/** The version a delta entry started from (its meta), or 0. */
	static int fromOf(String entryId) {
		JournalStore s = dev.larattalabs.architect.journal.WorldJournal.storeOrNull();
		try {
			com.google.gson.JsonObject m = s == null ? null : s.head(entryId).meta();
			return m == null ? 0 : m.get("from").getAsInt();
		} catch (java.io.IOException e) {
			return 0;
		}
	}

	/** (slice T4c, TEST dev.removal.failAfterCustody) The next n group or stage removals abort right after their custody is taken and saved. */
	public static final java.util.concurrent.atomic.AtomicInteger FAIL_AFTER_CUSTODY = new java.util.concurrent.atomic.AtomicInteger();

	/** (slice T4c) Ticks between a held decided removal's retries (1 s), doubling to {@link #HELD_RETRY_MAX} (20 s). */
	static final long HELD_RETRY = 20, HELD_RETRY_MAX = 400;

	static void tick(MinecraftServer server, long deadline) {
		tick++;
		// (slice T4c) a held decided removal (its undo committed) retries by itself: STALLED becomes held, never left to an operator's resume
		for (Removal r : List.copyOf(STALLED)) {
			if (r.heldDecided && tick >= r.retryAt && REMOVALS.stream().noneMatch(x -> x.group.equals(r.group))) {
				Architect.LOGGER.info("Removal of group {}{}: held (decided), retried", r.group, r.stage == null ? "" : " stage " + r.stage);
				resume(r, new CompletableFuture<>()); // its end retries again (held) or finishes it (REMOVAL_FINISHED)
			}
		}
		for (Removal r : List.copyOf(REMOVALS)) {
			if (System.nanoTime() >= deadline && r != REMOVALS.get(0)) {
				break;
			}
			try {
				long t0 = System.nanoTime();
				String was = r.planner != null ? "planning" : r.undo == null ? "start" : r.commit != null ? "commit" : "writes " + r.current;
				tick(server, r);
				if (Sites.Trace.ON && System.nanoTime() - t0 > 5_000_000L) {
					Architect.LOGGER.info("TRACE tick {} group {} {} -> {} {} ms", server.getTickCount(), r.group, was, r.planner != null ? "planning" : r.undo == null
						? "start" : r.commit != null ? "commit" : "writes " + r.current, (System.nanoTime() - t0) / 1e6);
				}
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Removing group {} failed", r.group, e);
				end(server, r, new Removed(false, List.of("it failed: " + e), Map.copyOf(r.refund)));
			}
		}
	}

	/**
	 * One removal's tick (docs/CONTRACT.md phase 4e "Groups, stages and the queue"): the group's (or stage's) standing sites
	 * become <b>one undo</b>, planned per section and committed once (hand-downs between members cancel out); then the writes
	 * go site by site in reverse placement order (instant sites over ticks, {@link RestoreJob}; construction sites at once,
	 * with the refunds computed before the undo was planned). A player in a box is waited for (up to 10 min); the player's
	 * things in a box stop the removal before anything is written.
	 */
	private static void tick(MinecraftServer server, Removal r) {
		if (r.creditWait != null) {
			if (tick < r.creditRetryAt) {
				return;
			}
			try {
				Stockpiles.saveCreditConfirmed(server); // (T4 final round) the waiting member's credit on disk first
			} catch (IllegalStateException e) {
				r.creditRetryAt = tick + 100;
				return;
			}
			r.sites.remove(r.creditWait);
			written.add(r.creditWait);
			r.creditWait = null;
		}
		if (r.current != null) {
			if (Placement.job(r.current) != null) {
				return; // a restore job runs (Placement); removed() moves on
			}
			// its job is gone (a load that could not resume it): write it again if it is still pending
			if (r.undo != null && Sites.pendingRecord(r.current) != null && !written(r.current)) {
				Placement.add(server, RestoreJob.writing(r.current, r.undo, r.current.equals(r.undoSites.isEmpty() ? null : r.undoSites.get(r.undoSites
					.size() - 1)) ? r.handed : Map.of()));
				return;
			}
			credit(server, r, r.current); // 6c Y: its restore was written (before a load): credited now, once per key
			r.sites.remove(r.current);
			written.add(r.current);
			r.current = null;
		}
		if (!r.started) {
			// the group's running batches are cancelled first (their placing items roll back)
			for (QBatch b : Batches.all()) {
				if (b.group.equals(r.group) && b.running()) {
					return;
				}
			}
			SiteGroupRec g = Sites.group(r.group);
			List<String> sites = new ArrayList<>(g == null ? List.of() : g.sites());
			java.util.Collections.reverse(sites);
			r.sites.addAll(sites);
			r.started = true;
			RemovalSeal.changed(); // (slice LC3) its members sealed from now on
		}
		if (r.nextCheck > tick) {
			return;
		}
		if (r.undo == null && r.planner == null && !preflighted(server, r)) {
			return;
		}
		// (slice DR-S) save first: a survival removal saves the world and the ledger before anything of it changes the world (its fluid
		// bodies' drain, a stage's irrigation, the player blocks' drop, the custody's take). A refused save (SS: a chunk write not durable) ends
		// it unwritten here, the world as it was (NOT_STARTED); the credit hold's own save in plan() comes after, before the drops
		if (r.undo == null && r.planned == null && !r.probed && survival(r)) {
			String refused = probe(() -> Stockpiles.saveWithWorld(server));
			if (refused != null) {
				end(server, r, Removed.saveRefused(r.group, refused, Map.copyOf(r.refund)));
				return;
			}
			r.probed = true;
		}
		// (6c H §4.1) a region's fluid bodies drain first and settle one bound before the group's undo is planned (the solids, shells
		// included, after: no source ever stands against a removed shell); the phase is saved, so a stop between resumes the wait
		if (r.undo == null && r.stage == null && !dev.larattalabs.architect.region.RegionFluids.removalGate(server, r.group)) {
			return;
		}
		if (r.undo == null && r.stage != null) {
			// (6c IRR, S-IRR-4) a stage undo that takes an irrigated farm lot takes its sources first (idempotent)
			for (String sid : r.sites) {
				Sites.drainIrrigation(server, Sites.get(sid));
			}
		}
		if (r.undo == null) {
			plan(server, r);
			return;
		}
		if (r.commit != null) {
			if (!r.commit.isDone()) {
				return;
			}
			if (r.commit.isCompletedExceptionally()) {
				r.undo = null;
				r.commit = null;
				dropPending(r); // (DR-S) the commit never reached the journal: its targets stand
				end(server, r, new Removed(false, List.of("the undo could not be saved to the world journal"), Map.copyOf(r.refund)));
				return;
			}
			r.commit = null;
			dev.larattalabs.architect.journal.WorldJournal.kill("K6");
			pendAll(server, r);
		} else {
			pendAll(server, r); // after a load: the records go pending if they did not yet (R3)
		}
		// (T2b part 2b) the crate.settle of each member written: before the next member (held: this tick ends, retried next)
		if (!settleWritten(server, r)) {
			return;
		}
		// R4: the writes, last placed first
		while (!r.sites.isEmpty() && (!r.undoSites.contains(r.sites.get(0)) || Sites.pendingRecord(r.sites.get(0)) == null && Sites.get(r.sites.get(0)) == null
			&& Infras.pending(r.sites.get(0)) == null)) {
			if (r.undoSites.contains(r.sites.get(0))) {
				credit(server, r, r.sites.get(0)); // 6c Y: written before a load (its record is gone): credited now, once per key
			}
			r.sites.remove(0);
		}
		if (r.sites.isEmpty() && r.crateSettle != null) {
			// (T2b part 2b) every member written: the group's shared crate settles (its stock), then its cell and its entry
			ServerLevel cl = Sites.levelOf(server, r.crateSettle.get("dim").getAsString());
			CrateSettle.Settled st = cl == null ? CrateSettle.Settled.NONE : CrateSettle.settle(cl, r.crateSettle);
			if (!st.done()) {
				return;
			}
			if (st.owed().isEmpty()) {
				st.given().forEach((k, v) -> r.refund.merge(k, v, Integer::sum)); // (T2b fix round P2-b) credited only: owed is listed apart
			}
			r.owed.addAll(st.owed());
			r.crateSettle = null;
			Placement.save(server, false);
		}
		if (r.sites.isEmpty()) {
			end(server, r, new Removed(true, List.of(), Map.copyOf(r.refund), r.restoredCells, Map.copyOf(r.handedAll), List.copyOf(r.cascaded), r.keptCells,
				null, List.copyOf(r.owed)));
			return;
		}
		String id = r.sites.get(0);
		Site s = Sites.pendingRecord(id);
		if (s == null && Infras.pending(id) != null) {
			// a road or cell site of the group: its cells over ticks
			r.current = id;
			Placement.add(server, RestoreJob.writing(id, r.undo, Map.of()));
			killAfterAMember(r);
			return;
		}
		ServerLevel level = s == null ? null : Sites.levelOf(server, s);
		if (s == null || level == null) {
			r.sites.remove(0);
			return;
		}
		Map<String, Integer> handedHere = r.handed;
		r.handed = Map.of();
		if (s.construction() != null) {
			// a construction site deconstructs at once (its refunds were tallied before the undo, rule 7), one per tick
			Map<String, Integer> items = r.decItems.getOrDefault(id, Map.of());
			long[] at = r.decAt.get(id);
			try {
				if (r.sites.size() < r.undoSites.size()) {
					dev.larattalabs.architect.journal.WorldJournal.kill("GM"); // (TEST, T2b txn-crash-crate) an earlier member written, this one not yet
				}
				Sites.Removed done = Sites.finishGroupDeconstruct(level, s, r.undo, items, at == null ? null : BlockPos.of(at[0]), handedHere);
				done.returned().forEach((k, v) -> r.refund.merge(k, v, Integer::sum));
				credit(server, r, id); // 6c Y: its stockpile refunds, once its restore is written (once per key)
			} catch (Sites.SiteException e) {
				end(server, r, new Removed(false, List.of(e.getMessage()), Map.copyOf(r.refund)));
				return;
			}
			r.sites.remove(0);
			written.add(id);
			settleWritten(server, r); // (T2b part 2b) its crate.settle now (held: next tick, before the next member)
			Placement.save(server, false);
			return;
		}
		r.current = id;
		Placement.add(server, RestoreJob.writing(id, r.undo, handedHere));
		killAfterAMember(r);
	}

	/**
	 * (T2b part 2b) Runs the crate.settle of every member already written (not in {@code r.sites}): its own crate's stock and its refunds,
	 * keyed (a replay after a restart never settles twice). False when one is held: the removal waits (the crate keeps its stock).
	 */
	private static boolean settleWritten(MinecraftServer server, Removal r) {
		boolean changed = false;
		for (var it = r.decSettle.entrySet().iterator(); it.hasNext();) {
			var e = it.next();
			if (r.sites.contains(e.getKey())) {
				continue;
			}
			ServerLevel level = Sites.levelOf(server, e.getValue().get("dim").getAsString());
			CrateSettle.Settled st = level == null ? CrateSettle.Settled.NONE : CrateSettle.settle(level, e.getValue());
			if (!st.done()) {
				if (changed) {
					Placement.save(server, false);
				}
				return false;
			}
			if (st.owed().isEmpty()) {
				st.given().forEach((k, v) -> r.refund.merge(k, v, Integer::sum)); // (T2b fix round P2-b) credited only: owed is listed apart
			}
			r.owed.addAll(st.owed());
			it.remove();
			changed = true;
		}
		if (changed) {
			Placement.save(server, false);
		}
		return true;
	}

	/**
	 * TEST kill point GW (F6 hazard, 4e-crash): a member's restore is written (out of the saved removal's sites) and the next member's
	 * job is saved; nothing of the next is written yet. With no autosave since the removal began, the written member's blocks come back.
	 */
	private static void killAfterAMember(Removal r) {
		if (r.sites.size() < r.undoSites.size()) {
			dev.larattalabs.architect.journal.WorldJournal.kill("GW");
		}
	}

	/** Sites whose undo writes were done in this session (a reload writes again only those not done). */
	private static final java.util.Set<String> written = new java.util.HashSet<>();

	private static boolean written(String id) {
		return written.contains(id);
	}

	/** R3 of a group undo: every member's record goes pending (once). */
	private static void pendAll(MinecraftServer server, Removal r) {
		List<Site> sites = new ArrayList<>();
		for (String id : r.undoSites) {
			Site s = Sites.get(id);
			if (s != null) {
				sites.add(s);
			}
			Infras.markPendingQuiet(id);
		}
		// one change of state, one save (the infra records are saved with it)
		Sites.markPendingAll(server, sites, "removed");
	}

	/** R1-R2 of a group undo: checks every member, tallies construction refunds, plans and submits one commit. */
	private static void plan(MinecraftServer server, Removal r) {
		if (r.planner != null) {
			// R1 over ticks (a large group plans per section; phase 4e budget)
			try {
				if (r.txn == null && !r.planner.step(Placement.deadline())) {
					return;
				}
				SiteJournal.Undone u;
				if (r.planner.sections() > RestoreJob.SPLIT_SECTIONS) {
					// a large undo: the plan's maps and its commit are made off the server thread, then submitted
					if (r.txn == null) {
						var p = r.planner;
						r.txn = CompletableFuture.supplyAsync(() -> {
							try {
								var w = p.work();
								var t = SiteJournal.undoTxn(w);
								// phase 6a: the commit's region merges too, off the server thread (a region's undo: 278 ms in one tick)
								return new Object[] {w, t, SiteJournal.store().prepare(t)};
							} catch (Sites.SiteException | java.io.IOException e) {
								throw new java.util.concurrent.CompletionException(e);
							}
						});
						return;
					}
					if (!r.txn.isDone() || !preSaved(server, r)) {
						if (r.preSave == Placement.NOT_SAVED) {
							endUnrecorded(server, r);
						}
						return;
					}
					Object[] built;
					try {
						built = r.txn.join();
					} finally {
						r.txn = null;
					}
					dev.larattalabs.architect.journal.WorldJournal.kill("K5");
					u = SiteJournal.submitUndoPrepared((dev.larattalabs.architect.journal.WorldJournal.UndoWork) built[0],
						(dev.larattalabs.architect.journal.JournalStore.Prepared) built[2]);
					if (u == null) {
						// another commit came in meanwhile: prepare it again against the new head
						var w = (dev.larattalabs.architect.journal.WorldJournal.UndoWork) built[0];
						var t = (dev.larattalabs.architect.journal.JournalStore.Txn) built[1];
						r.txn = CompletableFuture.supplyAsync(() -> {
							try {
								return new Object[] {w, t, SiteJournal.store().prepare(t)};
							} catch (Sites.SiteException | java.io.IOException e) {
								throw new java.util.concurrent.CompletionException(e);
							}
						});
						return;
					}
				} else {
					if (!preSaved(server, r)) {
						if (r.preSave == Placement.NOT_SAVED) {
							endUnrecorded(server, r);
						}
						return;
					}
					dev.larattalabs.architect.journal.WorldJournal.kill("K5");
					u = SiteJournal.submitUndo(r.planner.work());
				}
				r.planner = null;
				committed(server, r, u);
			} catch (java.io.IOException | Sites.SiteException | java.util.concurrent.CompletionException e) {
				r.planner = null;
				r.txn = null;
				end(server, r, new Removed(false, List.of(String.valueOf(e.getMessage())), Map.copyOf(r.refund)));
			}
			return;
		}
		if (r.planned != null && resumeCommitted(server, r)) {
			return;
		}
		// members with no standing record are not planned: gone ones leave the list wherever they stand (6d RV: a stage undo, a
		// revision's undo, leaves its members in the group's list, and a member settled at a load leaves no record at all)
		for (java.util.Iterator<String> it = r.sites.iterator(); it.hasNext();) {
			String id = it.next();
			if (Sites.get(id) != null || Infras.get(id) != null) {
				continue;
			}
			if ((Sites.pendingRecord(id) != null || Infras.pending(id) != null) && !written(id)) {
				// (6c X, C22) its restoration is unfinished (an earlier removal's): never answer removed over it
				end(server, r, new Removed(false, List.of(id + " has an unfinished restoration that this removal cannot resume"), Map.copyOf(r.refund)));
				return;
			}
			it.remove();
		}
		if (r.sites.isEmpty()) {
			end(server, r, new Removed(true, List.of(), Map.copyOf(r.refund)));
			return;
		}
		String dim = dimensionOf(r.sites.get(0));
		List<String> ids = new ArrayList<>();
		for (String id : r.sites) {
			if (dim.equals(dimensionOf(id))) {
				ids.add(id);
			}
		}
		ServerLevel level = Sites.levelOf(server, dim);
		if (level == null) {
			end(server, r, new Removed(false, List.of(dim + " is not loaded"), Map.copyOf(r.refund)));
			return;
		}
		// phase 6a: the per-member checks go over ticks under the placement budget (a region's 400 members took 210 ms at once)
		long deadline = Placement.deadline();
		while (r.scan < ids.size()) {
			String id = ids.get(r.scan);
			Site s = Sites.get(id);
			Infra inf = Infras.get(id);
			boolean placing = s != null ? s.placing() : inf != null && inf.placing();
			dev.larattalabs.architect.placement.Anchors.Bounds box = s != null ? s.restoreBox() : inf.box();
			boolean player = Occupancy.scan(level, box, e -> false).stream().anyMatch(f -> f.kind() == Occupancy.Kind.PLAYER);
			if (player || placing) {
				r.scan = 0;
				r.waited += Batches.RECHECK;
				r.nextCheck = tick + Batches.RECHECK;
				if (r.waited >= MAX_WAIT) {
					end(server, r, Removed.waitedOut(id, player, Map.copyOf(r.refund)));
				}
				return;
			}
			r.scan++;
			if (System.nanoTime() >= deadline && r.scan < ids.size()) {
				return;
			}
		}
		r.waited = 0;
		// sites outside the removal covering its cells (phase 4e): KEEP hands down, REFUSE refuses, CASCADE takes them first.
		// Phase 6a: found off the server thread (it reads every section of every member: 342 ms in one tick for a region)
		if (r.outsideF == null) {
			List<String> members = List.copyOf(ids);
			Sites.Covered cov = r.covered;
			r.outsideF = CompletableFuture.supplyAsync(() -> {
				java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
				java.util.Set<String> in = new java.util.HashSet<>(members);
				java.util.ArrayDeque<String> todo = new java.util.ArrayDeque<>(members);
				while (!todo.isEmpty()) {
					for (String c : SiteJournal.coveringSites(todo.poll())) {
						if (!in.contains(c) && out.add(c) && cov == Sites.Covered.CASCADE) {
							todo.add(c);
						}
					}
				}
				return out;
			});
			return;
		}
		if (!r.outsideF.isDone()) {
			return;
		}
		java.util.LinkedHashSet<String> outside;
		try {
			outside = r.outsideF.join();
		} catch (RuntimeException e) {
			r.outsideF = null;
			end(server, r, new Removed(false, List.of("the journal could not be read (" + e.getMessage() + ")"), Map.copyOf(r.refund)));
			return;
		}
		r.outsideF = null;
		if (!outside.isEmpty() && r.covered == Sites.Covered.REFUSE) {
			end(server, r, Removed.covered(outside, Map.copyOf(r.refund)));
			return;
		}
		if (!outside.isEmpty() && r.covered == Sites.Covered.CASCADE && r.blockerScan == 0) {
			List<String> top = new ArrayList<>(outside);
			java.util.Collections.reverse(top);
			top.removeIf(r.sites::contains);
			ids.addAll(0, top);
			r.sites.addAll(0, top);
			RemovalSeal.changed(); // (slice LC3) the cascaded sites sealed before their scan
			r.cascaded.addAll(top);
		}
		while (r.blockerScan < ids.size()) {
			String id = ids.get(r.blockerScan++);
			Site s = Sites.get(id);
			if (s == null) {
				continue;
			}
			List<String> blockers = Sites.removalBlockers(level, s, s.owner()); // 6c 0c (C18): the site owner's tagged entities
			if (!blockers.isEmpty()) {
				end(server, r, Removed.blocked(id, blockers, false, Map.copyOf(r.refund)));
				return;
			}
			if (System.nanoTime() >= Placement.deadline() && r.blockerScan < ids.size()) {
				r.outsideF = CompletableFuture.completedFuture(outside); // keep what was found; go on next tick
				return;
			}
		}
		// (slice PSVLC3, P1 1) a standing legacy crate's stock recorded with the removal in a confirmed queue write before R1 takes it
		if (!crateRecorded(server, level, r, ids)) {
			r.outsideF = CompletableFuture.completedFuture(outside); // what was found is kept; the checks go on once the write is confirmed
			return;
		}
		if (!r.cargoApplied) {
			r.cargo.clear(); // (fix round) found again below, per region target (a replan after the holders were replaced keeps their cargo)
		}
		// (M5 FK) a filled site's declared containers: their contents into the ledger's custody in this tick (the credit is fixed now; the
		// undo writes them ticks later), then saved with the world; cargo found now ends the removal unwritten, the custody given back
		boolean custody = false;
		for (String id : ids) {
			Site s = Sites.get(id);
			if (s != null && s.construction() != null && Fills.filledSite(s)) {
				String cargo = Fills.takeCustody(level, s, false);
				if (cargo != null) {
					for (String back : ids) {
						Site b = Sites.get(back);
						if (b != null) {
							Fills.writeBack(level, b); // (PSV fix round) by the custody held (none: nothing), not by the phase
						}
					}
					end(server, r, Removed.blocked(id, List.of(cargo), true, Map.copyOf(r.refund)));
					return;
				}
				custody = true;
			}
		}
		if (custody) {
			String refused = probe(() -> Stockpiles.saveWithWorld(server)); // (DR-S) a refused save gives the custody back: nothing changed
			if (refused != null) {
				for (String back : ids) {
					Site b = Sites.get(back);
					if (b != null && Fills.phase(b) != null) {
						Fills.writeBack(level, b);
					}
				}
				end(server, r, Removed.saveRefused(r.group, refused, Map.copyOf(r.refund)));
				return;
			}
			dev.larattalabs.architect.journal.WorldJournal.kill("FKC1"); // (TEST) the custody saved, the undo's world write not yet
			if (FAIL_AFTER_CUSTODY.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
				// (slice T4c, TEST dev.removal.failAfterCustody; Steward's FKC0) aborted right after its custody: given back, saved, ended (nothing
				// of it decided: NOT_STARTED, its targets stand)
				for (String back : ids) {
					Site b = Sites.get(back);
					if (b != null) {
						Fills.writeBack(level, b);
					}
				}
				probe(() -> Stockpiles.saveWithWorld(server));
				dev.larattalabs.architect.journal.WorldJournal.kill("FKC0"); // (TEST) the abort's custody given back and saved
				end(server, r, Removed.saveRefused(r.group, "TEST: dev.removal.failAfterCustody", Map.copyOf(r.refund)));
				return;
			}
		}
		// refunds against the stacks before the undo is planned (rule 7)
		List<Infra> dropLater = new ArrayList<>();
		for (String id : ids) {
			Site s = Sites.get(id);
			if (s != null && s.construction() != null) {
				Builder.Deconstruction d = Builder.prepareDeconstruct(level, s);
				r.decItems.put(id, Map.copyOf(d.all()));
				r.decAt.put(id, new long[] {d.at().asLong()});
				if (d.settle() != null) {
					r.decSettle.put(id, d.settle()); // (T2b part 2b) its crate's stock and its refunds: settled once its restore is written
				}
				if (d.stockpile() != null) {
					r.decCredit.put(id, new Credit(d.stockpile(), d.key(), Map.copyOf(d.credit()), d.at().asLong()));
				}
				continue;
			}
			Infra inf = Infras.get(id);
			// (7a GM-a2) a survival region's gate mechanism: what of its charge stands, credited once its restore is written
			Credit mc = inf == null ? null : MechCharges.refund(level, inf);
			if (mc != null) {
				r.decCredit.put(id, mc);
				continue;
			}
			Stockpiles.Pile pile = inf == null ? null : Stockpiles.pileOf(inf);
			if (pile != null) {
				// (6c RS §9) a player's block in a region target drops at its cell; (J1, F10 for roads) a player's matching block is theirs, not
				// refunded. (DR-S) Found now, left out of the refund, dropped only once the credits are saved (a refused save drops nothing)
				var dropped = RegionTargets.dropPlayerBlocks(level, inf, false);
				// (fix round, GPT P1 4) a player's holder in one of those cells: its contents are credited (never dropped); one with items carrying
				// their own data (a name, an enchantment, contents) can't be credited by id: the removal ends, the holders as they are
				String cargoNo = findCargo(level, r, id, inf, pile, dropped);
				if (cargoNo != null) {
					for (String back : ids) {
						Site b = Sites.get(back);
						if (b != null && Fills.phase(b) != null) {
							Fills.writeBack(level, b);
						}
					}
					end(server, r, new Removed(false, List.of(cargoNo), Map.copyOf(r.refund)));
					return;
				}
				var matches = RoadBuilder.dropPlayerMatches(level, inf, false);
				dropLater.add(inf);
				if (!matches.isEmpty()) {
					dropped = new it.unimi.dsi.fastutil.longs.LongOpenHashSet(dropped);
					dropped.addAll(matches);
				}
				// (XR) a cell a later writer of the region owns (it matches what stands there) is that writer's refund, not this one's
				Builder.Run ir = RoadBuilder.run(level.getServer(), inf);
				if (ir != null) {
					var shadow = RegionOverwrites.shadowedCells(level.getServer(), level, inf.group(), inf.id(), inf.placedAt(), ir, true);
					if (!shadow.isEmpty()) {
						dropped = new it.unimi.dsi.fastutil.longs.LongOpenHashSet(dropped);
						dropped.addAll(shadow);
					}
				}
				// 6c Y: a stockpile's construction road: its paid cells standing, credited once its restore is written
				r.decCredit.put(id, new Credit(pile.owner(), RoadBuilder.creditKey(inf), Map.copyOf(RoadBuilder.refundOf(level, inf, dropped)), RoadBuilder.dropAt(inf)
					.asLong()));
				RegionTargets.leaving(level.getServer(), inf);
			}
		}
		// (slice DR-S) each site or road credit held pending in its pile's ledger and saved with the world before the commit (J2's rule for a
		// single site): the queued removal is no longer its only store, so a removal that ends (or a queue file saved without it) with the
		// credit unbooked rolls it forward at the next start (Stockpiles.settlePendingCredits) or by a repair (Repairs), never twice (the
		// credit's key). Gate mechanisms' keys (region:...:mech:) are not target keys: they stay in the removal only
		if (holdPending(r)) {
			try {
				Stockpiles.saveWithWorld(server);
				if (!r.cargo.isEmpty() && !r.cargoApplied) {
					// (fix round, GPT P1 4) the holders' contents pending in the ledger and the holders as they are, both durable before any
					// holder is replaced (T0's barrier: a /save-off world saves nothing, so a plain save is not enough)
					DurableBarrier.Result b = Stockpiles.barrier(server);
					if (!b.ok()) {
						throw new IllegalStateException("the world barrier before a player's container is replaced was " + b.outcome() + " (" + b.reason() + ")");
					}
				}
			} catch (IllegalStateException e) {
				// nothing dropped yet (dropLater): the player blocks stand as they were
				dropPending(r);
				dropCargoPending(r);
				for (String back : ids) {
					Site b = Sites.get(back);
					if (b != null && Fills.phase(b) != null) {
						Fills.writeBack(level, b);
					}
				}
				end(server, r, Removed.saveRefused(r.group, e.getMessage(), Map.copyOf(r.refund)));
				return;
			}
		}
		// (DR-S) the credits are saved: now the player blocks found above drop at their cells (the same cells: nothing changed since)
		for (Infra inf : dropLater) {
			RegionTargets.dropPlayerBlocks(level, inf, true);
			RoadBuilder.dropPlayerMatches(level, inf, true);
		}
		r.cargoApplied |= !r.cargo.isEmpty();
		if (!r.cargo.isEmpty()) {
			// (slice PSVLC3 fix round, GPT P1 1; T4a: no crate is taken at R1 since T2b) a player's holder replaced: the undo commits only once T0's barrier (players,
			// chunks, then the ledger) made them durable; tried now, else before the commit (preSaved) until it is OK
			r.worldPending = true;
			worldDurable(server, r);
		}
		String group = dev.larattalabs.architect.site.SiteJournal.group(r.stage == null ? "group-" + r.group : "stage-" + r.group + "-" + r.stage);
		List<String> withCrate = new ArrayList<>(ids);
		if (r.stage == null) {
			// (T2b part 2b) the group's shared crate settles after every member is written (its cell restored by that settle, its entry released
			// there): its CRATE entry stays out of the undo; with no crate to settle it goes with the group's undo as before
			List<Site> members = new ArrayList<>();
			for (String id : ids) {
				Site m = Sites.get(id);
				if (m != null) {
					members.add(m);
				}
			}
			String owner = SiteGroupRec.CRATE_PREFIX + r.group;
			boolean memberSettles = r.decSettle.values().stream().anyMatch(st -> CrateSettle.hasCrate(st) && owner.equals(st.get("crateOwner").getAsString()));
			r.crateSettle = memberSettles ? null : CrateSettle.groupStash(r.group, members);
			if (r.crateSettle == null) {
				withCrate.add(owner); // the group's shared crate goes with the group
			}
		}
		try {
			List<String> entries = new ArrayList<>();
			List<String> keep = new ArrayList<>();
			for (String id : ids) {
				Site m = Sites.get(id);
				if (m != null) {
					keep.addAll(CrateSettle.excluded(m, r.decSettle.get(id))); // (T2b part 2b) a member's own crate its settle restores
				}
			}
			for (String id : withCrate) {
				SiteJournal.active(id).forEach(m -> {
					if (!keep.contains(m.id())) {
						entries.add(m.id());
					}
				});
			}
			if (entries.isEmpty()) {
				end(server, r, new Removed(false, List.of("nothing of group " + r.group + " is in the world journal"), Map.copyOf(r.refund)));
				return;
			}
			r.planIds = List.copyOf(ids);
			r.planGroup = group;
			try {
				r.planner = new dev.larattalabs.architect.journal.WorldJournal.UndoPlanner(level, entries, group);
			} catch (java.io.IOException e) {
				throw new Sites.SiteException(dev.larattalabs.architect.api.Reason.JOURNAL_UNAVAILABLE, "the journal can't be read (" + e.getMessage() + ")");
			}
			plan(server, r); // as far as this tick's budget goes
		} catch (Sites.SiteException e) {
			end(server, r, new Removed(false, List.of(e.getMessage()), Map.copyOf(r.refund)));
		}
	}

	/**
	 * (fix/drain-holders) Before R2 is submitted: the undo group and its sites saved in the queue file, and that save written (over ticks;
	 * the saver is off the server thread). Without it, a stop after the commit reached the journal and before {@link #committed}'s save
	 * left a queue file with no undo: the load planned again, found no active entry and ended the removal false over a drained region.
	 */
	static boolean preSaved(MinecraftServer server, Removal r) {
		if (!worldDurable(server, r)) {
			return false; // (fix round, GPT P1 1) R1's takes not durable yet: no pre-save, no commit
		}
		if (r.planned == null || !r.planned.equals(r.planGroup)) {
			r.planned = r.planGroup;
			r.plannedSites.clear();
			r.plannedSites.addAll(r.planIds);
			r.preSave = Placement.preSave(server);
			return false;
		}
		if (Placement.failed(r.preSave)) {
			// (PSV fix round, GPT P1 3) its write failed after R1: the plan and its tallies are not committed against a world that may change
			// while writes fail (a block mined, a block replaced): dropped, planned again once a queue write is confirmed
			dropPlan(r);
			return false;
		}
		return preSaveWritten(r.preSave);
	}

	/**
	 * (PSV fix round, GPT P1 3) The removal's preflight (before anything is touched, each R1): a queue save confirmed written and no write
	 * failing since. While writes fail the removal waits untouched (Placement retries every 5 s); the queue file failed to load: it ends,
	 * untouched (a removal loaded or asked before {@link #UNRECORDABLE} took effect never reaches here: the queue started empty).
	 */
	private static boolean preflighted(MinecraftServer server, Removal r) {
		if (Placement.loadFailed()) {
			r.planned = null;
			r.plannedSites.clear();
			end(server, r, new Removed(false, List.of(UNRECORDABLE), Map.copyOf(r.refund)));
			return false;
		}
		return r.preflight.ready(() -> Placement.save(server, false));
	}

	/**
	 * (PSV fix round) A plan whose pre-save failed, dropped before its commit: R1 runs again from the checks once a queue write is confirmed
	 * (its refunds re-tallied against the world then; the custody already held stays held, a legacy crate's stock is carried in
	 * {@link Removal#decStock}). Nothing was committed, so nothing is undone.
	 */
	static void dropPlan(Removal r) {
		Architect.LOGGER.warn("Removal of group {}: the queue file write holding its planned undo failed; the plan is dropped and made again once a queue "
			+ "write is confirmed", r.group);
		r.planner = null;
		r.txn = null;
		r.planGroup = null; // (planIds kept: end() gives back the custody held for them)
		r.planned = null;
		r.plannedSites.clear();
		r.preSave = 0;
		r.scan = 0;
		r.blockerScan = 0;
		r.outsideF = null;
		r.preflight.gen = 0;
		for (String id : List.copyOf(r.decItems.keySet())) {
			if (!r.decStock.containsKey(id)) {
				r.decItems.remove(id);
				r.decAt.remove(id);
			}
		}
		dropPending(r); // (slice PSVLC3) DR-S's held pending credits go with the plan (the replan holds them again); none stays behind unowned
		r.decCredit.clear();
		r.decSettle.clear(); // (T4a) T2b's crate settles are fixed again by the replan's prepare (nothing was taken: the crates keep their stock)
		r.crateSettle = null;
		r.crateGen = 0;
		r.barrierAt = 0; // (fix round) worldPending stays: what R1 changed is still to be made durable
	}

	/**
	 * (PSV fix round) A member's deconstruct items: {@code all} (this R1's tally, its crate stock in it) plus the crate stock an earlier R1 of
	 * this removal took; this R1's crate stock is added to what is carried.
	 */
	static Map<String, Integer> withStock(Removal r, String id, Map<String, Integer> all, Map<String, Integer> crateStock) {
		return withStock(r, id, all, crateStock, !crateStock.isEmpty());
	}

	/**
	 * (slice PSVLC3, P1 1) {@link #withStock} by the world's evidence: {@code crateStood}, the member's crate stood before this R1's take.
	 * Standing, its take never reached the disk (a crash put the world back to its last save, or nothing was taken yet), so nothing carried
	 * is real: this take is the stock, once, and replaces what was carried (adef7f9b added it: twice). Gone, what is carried is the only
	 * record of the take on disk and is added once.
	 */
	static Map<String, Integer> withStock(Removal r, String id, Map<String, Integer> all, Map<String, Integer> crateStock, boolean crateStood) {
		Map<String, Integer> items = new TreeMap<>(all);
		if (crateStood) {
			if (crateStock.isEmpty()) {
				r.decStock.remove(id);
			} else {
				r.decStock.put(id, new TreeMap<>(crateStock));
			}
			return items;
		}
		Map<String, Integer> carried = r.decStock.get(id);
		if (carried != null) {
			carried.forEach((k, v) -> items.merge(k, v, Integer::sum));
		}
		if (!crateStock.isEmpty()) {
			Map<String, Integer> m = new TreeMap<>(carried == null ? Map.of() : carried);
			crateStock.forEach((k, v) -> m.merge(k, v, Integer::sum));
			r.decStock.put(id, m);
		}
		return items;
	}

	/**
	 * (slice PSVLC3, P1 1) Persist before mutate for a legacy crate's stock: each standing crate R1 is about to take has its stock recorded in
	 * {@link Removal#decStock} (a standing crate's record replaces what was carried: the world says that take never reached the disk), and
	 * the queue save holding it is confirmed written with no write failing since, before the take. True when R1 may go on (nothing to take,
	 * or the record confirmed); false while it waits. The take then happens in the same tick as this check (nothing changes the crate between).
	 * Whichever of the queue file and the world's chunks a crash keeps, the stock is counted once: the crate stands (its stock is taken again,
	 * the record replaced) or it is gone (the record, confirmed before the take, is carried).
	 */
	static boolean crateRecorded(MinecraftServer server, ServerLevel level, Removal r, List<String> ids) {
		boolean takes = false;
		boolean changed = false;
		for (String id : ids) {
			Site s = Sites.get(id);
			if (s == null || s.construction() == null || !Builder.crateStands(level, s)) {
				continue; // no crate, or it is gone: what is carried (if anything) is the take on disk
			}
			Map<String, Integer> t = Builder.crateTake(level, s);
			Map<String, Integer> want = t == null || t.isEmpty() ? null : new TreeMap<>(t);
			takes |= want != null;
			if (!java.util.Objects.equals(want, r.decStock.get(id))) {
				if (want == null) {
					r.decStock.remove(id);
				} else {
					r.decStock.put(id, want);
				}
				changed = true;
			}
		}
		return switch (crateStep(takes, changed, r.crateGen, Placement.failed(r.crateGen), Placement.written(r.crateGen) && !Placement.writeFailing())) {
			case SAVE -> {
				r.crateGen = Placement.save(server, false);
				yield false;
			}
			case WAIT -> false;
			case GO -> true;
		};
	}

	/** (fix round) {@link #crateRecorded}'s step. */
	enum CrateStep {
		SAVE, WAIT, GO
	}

	/**
	 * (pure; fix round, GPT P1 2) {@link #crateRecorded}'s decision: a changed record (a new take's stock, or one cleared because the crate
	 * emptied) is saved and waited for before R1 goes on, takes or not (ca946197 went on at once when no take was left: a crash could then keep
	 * a cleared record's stock beside the blocks built from it); a record asked for is waited for until written with no write failing; with
	 * nothing to take and no record asked for, R1 goes on.
	 */
	static CrateStep crateStep(boolean takes, boolean changed, long gen, boolean failed, boolean confirmed) {
		if (changed || takes && (gen == 0 || failed) || gen > 0 && failed) {
			return CrateStep.SAVE;
		}
		if (gen > 0) {
			return confirmed ? CrateStep.GO : CrateStep.WAIT;
		}
		return CrateStep.GO;
	}

	/**
	 * (slice PSV) Whether a pre-save lets the commit go: none this session (0: the planned undo came from the file), or its generation
	 * confirmed written (fsynced and renamed). A failed write is not: the removal waits while Placement retries the save every 5 s.
	 * {@link Placement#NOT_SAVED} (the queue file failed to load this session) never is.
	 */
	static boolean preSaveWritten(long gen) {
		return gen == 0 || Placement.written(gen);
	}

	/**
	 * (slice PSV) The queue file failed to load this session, so nothing is saved over it and an undo can't be recorded: the removal ends
	 * before its commit, unwritten (as a cargo blocker: the custody R1 took is given back and saved with the ledger).
	 */
	private static void endUnrecorded(MinecraftServer server, Removal r) {
		boolean back = false;
		for (String id : r.planIds) {
			Site b = Sites.get(id);
			ServerLevel level = b == null ? null : Sites.levelOf(server, b.dimension());
			if (level != null && Fills.holdsCustody(b)) {
				Fills.writeBack(level, b);
				back = true;
			}
		}
		if (back) {
			Stockpiles.saveWithWorld(server);
		}
		r.planner = null;
		r.txn = null;
		r.planned = null; // (PSV fix round) unwound: end() sees an untouched removal
		r.plannedSites.clear();
		end(server, r, new Removed(false, List.of(UNRECORDABLE), Map.copyOf(r.refund)));
	}

	/**
	 * (fix/drain-holders) A load with a {@link Removal#planned} undo and no {@link Removal#undo}: the stop came between the commit's
	 * submission and the save after it. The journal decides: entries of the planned sites UNDONE in that group mean R2 is durable, and the
	 * removal resumes R3/R4 under it (true; its hand-down counts are not known again: the result reports none); else R2 never reached the
	 * disk and the removal plans again (false).
	 */
	private static boolean resumeCommitted(MinecraftServer server, Removal r) {
		String g = r.planned;
		boolean durable = false;
		List<String> ids = new ArrayList<>(r.plannedSites);
		if (r.stage == null) {
			ids.add(SiteGroupRec.CRATE_PREFIX + r.group);
		}
		for (String id : ids) {
			for (dev.larattalabs.architect.journal.JournalStore.Meta m : SiteJournal.entries(id)) {
				if (m.status() == Journal.Status.UNDONE && g.equals(m.undoGroup())) {
					durable = true;
					break;
				}
			}
			if (durable) {
				break;
			}
		}
		r.planned = null;
		if (!durable) {
			r.plannedSites.clear();
			Architect.LOGGER.info("Removal of group {}: its undo {} was not committed before the stop; it is planned again", r.group, g);
			return false;
		}
		r.undo = g;
		r.undoSites.clear();
		r.undoSites.addAll(r.plannedSites);
		r.plannedSites.clear();
		for (String id : r.undoSites) {
			if (!r.sites.contains(id)) {
				r.sites.add(0, id); // (a cascaded site: taken first, as planned)
				RemovalSeal.changed();
			}
		}
		r.handed = new TreeMap<>();
		r.handedAll = new TreeMap<>();
		retakeStanding(server, r);
		Placement.save(server, false);
		Architect.LOGGER.info("Removal of group {}: its undo {} was committed before the stop; the removal resumes its writes", r.group, g);
		return true;
	}

	/**
	 * (fix round, GPT P1 1) R1's standing-crate rule for an undo committed before a stop: a member whose crate still stands lost its take at
	 * the stop (the commit waits for the barrier, so only a world older than that barrier can show it): the crate is taken again now and its
	 * stock replaces what was carried in the member's deconstruct items, once.
	 */
	private static void retakeStanding(MinecraftServer server, Removal r) {
		for (String id : List.copyOf(r.decStock.keySet())) {
			Site s = Sites.get(id) != null ? Sites.get(id) : Sites.pendingRecord(id);
			ServerLevel lv = s == null ? null : Sites.levelOf(server, s);
			if (lv == null || s.construction() == null || !Builder.crateStands(lv, s)) {
				continue;
			}
			Map<String, Integer> carried = r.decStock.get(id);
			Map<String, Integer> items = new TreeMap<>(r.decItems.getOrDefault(id, Map.of()));
			carried.forEach((k, v) -> items.merge(k, -v, Integer::sum));
			Builder.Deconstruction d = Builder.prepareDeconstruct(lv, s);
			d.crateStock().forEach((k, v) -> items.merge(k, v, Integer::sum));
			items.values().removeIf(v -> v <= 0);
			r.decItems.put(id, Map.copyOf(items));
			if (d.crateStock().isEmpty()) {
				r.decStock.remove(id);
			} else {
				r.decStock.put(id, new TreeMap<>(d.crateStock()));
			}
			r.worldPending = true;
			Architect.LOGGER.warn("Removal of group {}: {}'s crate stood after the stop: taken again ({}), its carried stock {} replaced", r.group, id,
				d.crateStock(), carried);
		}
		if (r.worldPending) {
			worldDurable(server, r);
		}
	}

	/** R2 submitted: the removal waits for its commit, then marks the records pending and writes. */
	private static void committed(MinecraftServer server, Removal r, SiteJournal.Undone u) {
		r.planned = null;
		r.plannedSites.clear();
		r.undo = r.planGroup;
		r.undoSites.clear();
		r.undoSites.addAll(r.planIds);
		r.handed = new TreeMap<>(Sites.handedBySite(u.work()));
		r.handedAll = new TreeMap<>(r.handed);
		r.restoredCells = u.work().plan().stats().values().stream().mapToInt(Journal.Stats::restored).sum();
		r.keptCells = u.work().plan().stats().values().stream().mapToInt(Journal.Stats::changed).sum();
		r.commit = u.commit();
		String k = dev.larattalabs.architect.journal.WorldJournal.armed();
		if (k != null && k.startsWith("R2q")) {
			// TEST (dev.journal.killAt R2q): the commit durable, the halt before the queue file below is saved (the journal's writer and
			// the queue's saver are separate threads, so either can reach the disk first)
			try {
				r.commit.join();
			} catch (RuntimeException e) {
				// the halt below either way
			}
			dev.larattalabs.architect.journal.WorldJournal.kill("R2q");
		}
		Placement.save(server, false);
	}

	private static String dimensionOf(String id) {
		Site s = Sites.get(id);
		if (s != null) {
			return s.dimension();
		}
		Infra i = Infras.get(id);
		return i != null ? i.dimension() : Site.OVERWORLD;
	}

	/** Whether a removal in progress takes this site down (it can't be layered over meanwhile). */
	static boolean removing(String siteId) {
		for (Removal r : REMOVALS) {
			if (r.sites.contains(siteId) || r.undoSites.contains(siteId)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * (C29 a) Whether a removal has started on this target: it is in a running removal's sites (from its start, through the wait
	 * for a player and the planning, until its record goes pending), or the removal is a whole-group one that has not listed its
	 * sites yet (its batches still cancelling) and the target is of that group; or a single road or cell site's removal job runs
	 * for it. Such a target leaves its stockpile's feed at once ({@link Stockpiles}): no step, no reservation, no need. A stalled
	 * removal's members are pending already. Server thread.
	 */
	static boolean leaving(String id) {
		if (!REMOVALS.isEmpty()) {
			for (Removal r : REMOVALS) {
				if (r.sites.contains(id) || r.undoSites.contains(id)) {
					return true;
				}
				if (r.stage == null && !r.started) {
					Site s = Sites.get(id);
					Infra i = s == null ? Infras.get(id) : null;
					String g = s != null ? s.group() : i != null ? i.group() : null;
					if (r.group.equals(g)) {
						return true;
					}
				}
			}
		}
		return Placement.job(id) instanceof RestoreJob rj && RestoreJob.REMOVE.equals(rj.purpose);
	}

	/** A restore job of a removal finished (Placement). */
	static void removed(MinecraftServer server, RestoreJob job) {
		for (Removal r : REMOVALS) {
			if (job.siteId.equals(r.current)) {
				r.current = null;
				if (job.broken != null) {
					// (6c X, C22) a restore that broke is not done: the member stays (pending) for the retry
					end(server, r, new Removed(false, List.of(job.siteId + ": " + job.broken), Map.copyOf(r.refund)));
					return;
				}
				try {
					credit(server, r, job.siteId); // 6c Y: a stockpile road's refunds, once its restore is written
				} catch (IllegalStateException e) {
					// (T4 final round, SOFF2's rule) its credit's save was refused (SaveRefused): booked once in memory (keyed), never thrown out of
					// the Placement tick (that stalled every job, each tick); the member stays in the removal until a confirmed save, retried
					r.creditWait = job.siteId;
					r.creditRetryAt = tick + 100;
					Architect.LOGGER.error("Removing group {}: {}'s credit save was refused ({}); it waits and retries", r.group, job.siteId, e.getMessage());
					return;
				}
				r.sites.remove(job.siteId);
				written.add(job.siteId);
				return;
			}
		}
	}

	/** (DR-S) Runs a save; returns null when it was written, else why it was refused (SS: {@code IllegalStateException}). */
	static @Nullable String probe(Runnable save) {
		try {
			save.run();
			return null;
		} catch (IllegalStateException e) {
			return e.getMessage();
		}
	}

	/** (DR-S) Whether a removal takes a survival target (a construction site or a fed road/region target): it saves first. */
	static boolean survival(Removal r) {
		for (String id : r.sites) {
			Site s = Sites.get(id);
			Infra i = s == null ? Infras.get(id) : null;
			if (s != null && s.construction() != null || i != null && i.construction() != null) {
				return true;
			}
		}
		return false;
	}

	/** (DR-S) Holds each target-keyed {@link Removal#decCredit} pending in its pile's ledger; true when any was held. */
	static boolean holdPending(Removal r) {
		boolean any = false;
		for (Credit c : r.decCredit.values()) {
			Stockpiles.Pile p = Stockpiles.get(c.owner());
			if (p != null && dev.larattalabs.architect.survival.StockLedger.isTargetKey(c.key()) && !p.ledger().credited(c.key())) {
				p.ledger().holdPending(c.key(), c.items(), c.at());
				Stockpiles.changed(p);
				any = true;
			}
		}
		for (Credit c : r.cargo.values()) {
			Stockpiles.Pile p = Stockpiles.get(c.owner());
			if (p != null && !p.ledger().credited(c.key())) {
				p.ledger().holdPending(c.key(), c.items(), c.at()); // (fix round) the holder's contents, before the holder is replaced
				Stockpiles.changed(p);
				any = true;
			}
		}
		return any;
	}

	/**
	 * (fix round, GPT P1 4) A player holder's credit key: {@code cargo:<target>@<placedAt>:<cell>}. (slice T4c, PL-gpt2 3) The target's placement
	 * is in it, so a target id placed again (a region realised again, its tile ids reused) never finds an earlier removal's key credited and
	 * loses its holder's contents; a retry of the same removal finds its own key (one credit).
	 */
	static String cargoKey(String targetId, long placedAt, long cell) {
		return Stockpiles.CARGO_PREFIX + targetId + "@" + placedAt + ":" + cell;
	}

	/**
	 * (pure; fix round) The items a player holder's contents credit by id, or null when a stack carries its own data (a name, an enchantment,
	 * a filled shulker box): crediting it by id would lose that data.
	 */
	static @Nullable Map<String, Integer> cargoItems(List<net.minecraft.world.item.ItemStack> contents) {
		List<Stack> l = new ArrayList<>();
		for (net.minecraft.world.item.ItemStack st : contents) {
			l.add(new Stack(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), !st.getComponentsPatch().isEmpty()));
		}
		return cargoOf(l);
	}

	/** (pure) A holder's stack: its item id, its count, whether it carries its own data (a components patch). */
	record Stack(String item, int count, boolean ownData) {
	}

	/** (pure) {@link #cargoItems} over {@link Stack}s. */
	static @Nullable Map<String, Integer> cargoOf(List<Stack> contents) {
		Map<String, Integer> m = new TreeMap<>();
		for (Stack st : contents) {
			if (st.ownData()) {
				return null;
			}
			m.merge(st.item(), st.count(), Integer::sum);
		}
		return m;
	}

	/** (fix round, GPT P1 4) {@link Removal#cargo} for a region target's player cells {@code cells}; why not, or null. */
	private static @Nullable String findCargo(ServerLevel level, Removal r, String id, Infra inf, Stockpiles.Pile pile,
		it.unimi.dsi.fastutil.longs.LongSet cells) {
		for (long c : cells) {
			List<net.minecraft.world.item.ItemStack> st = Builder.holderContents(level.getBlockEntity(net.minecraft.core.BlockPos.of(c)));
			if (st.isEmpty()) {
				continue;
			}
			Map<String, Integer> items = cargoItems(st);
			if (items == null) {
				return "a player's container at " + net.minecraft.core.BlockPos.of(c).toShortString() + " in " + id
					+ " holds items with their own data (named, enchanted or filled): take them out, then remove again";
			}
			String key = cargoKey(inf.id(), inf.placedAt(), c);
			r.cargo.putIfAbsent(key, new Credit(pile.owner(), key, Map.copyOf(items), c));
		}
		return null;
	}

	/**
	 * (fix round, GPT P1 1 and 4) T0's barrier over what R1 changed outside the journal; on OK the player holders' contents are booked into
	 * the stock (their pending credits dropped). False (waiting, retried every 5 s) when it is refused or in doubt.
	 */
	static boolean worldDurable(MinecraftServer server, Removal r) {
		if (!r.worldPending) {
			return true;
		}
		if (tick < r.barrierAt) {
			return false;
		}
		DurableBarrier.Result b = Stockpiles.barrier(server);
		if (!b.ok()) {
			r.barrierAt = tick + 100;
			Architect.LOGGER.warn("Removal of group {}: the world barrier after R1's takes was {} ({}); the undo waits, not committed, until it is OK",
				r.group, b.outcome(), b.reason());
			return false;
		}
		r.worldPending = false;
		for (Credit c : r.cargo.values()) {
			Stockpiles.Pile p = Stockpiles.get(c.owner());
			if (p != null) {
				Stockpiles.credit(server, p, c.key(), c.items(), net.minecraft.core.BlockPos.of(c.at()));
				p.ledger().dropPending(c.key());
				Stockpiles.changed(p);
			}
		}
		r.cargo.clear();
		r.cargoApplied = false;
		return true;
	}

	/** (fix round) Cargo held pending whose holders were never replaced: dropped (the holders keep their contents). */
	static void dropCargoPending(Removal r) {
		if (r.cargoApplied) {
			return;
		}
		for (Credit c : r.cargo.values()) {
			Stockpiles.Pile p = Stockpiles.get(c.owner());
			if (p != null && p.ledger().pendingKeys().contains(c.key())) {
				p.ledger().dropPending(c.key());
				Stockpiles.changed(p);
			}
		}
		r.cargo.clear();
	}

	/** (DR-S) The removal ended unwritten (no undo): its held pending credits dropped (the targets stand). */
	static void dropPending(Removal r) {
		for (Credit c : r.decCredit.values()) { // (fix round) a holder's cargo pending stays: its holder may be replaced already
			Stockpiles.Pile p = Stockpiles.get(c.owner());
			if (p != null && p.ledger().pendingKeys().contains(c.key())) {
				p.ledger().dropPending(c.key());
				Stockpiles.changed(p);
			}
		}
	}

	private static void end(MinecraftServer server, Removal r, Removed given) {
		// (T4b, finding 5) a removal that ends stopped or failed still reports the owed keys its settles wrote so far
		Removed result = !r.owed.isEmpty() && given.owed().isEmpty() ? new Removed(given.removed(), given.blockers(), given.refund(), given.restored(),
			given.handedDown(), given.cascaded(), given.kept(), given.cause(), List.copyOf(r.owed)) : given;
		REMOVALS.remove(r);
		// (slice T4c) once its undo committed (the decision), a group's or stage's removal never answers PARTIAL: it is held(decided), kept and
		// retried by itself (Groups.tick), and REMOVAL_FINISHED fires once it is removed
		boolean decided = !result.removed() && r.undo != null;
		dropCargoPending(r); // (fix round) holders never replaced keep their contents
		if (r.worldPending) {
			r.barrierAt = 0;
			worldDurable(server, r); // (fix round) a holder replaced: booked once durable, else its pending credit settles at the next start
		}
		if (!result.removed() && r.undo == null) {
			voidStanding(server, r);
		}
		if (!result.removed() && r.undo == null && r.planned == null) {
			dropPending(r); // (DR-S) nothing of it was committed: its targets stand
		}
		if (!result.removed() && r.undo == null) {
			// (M5 FK) ended before its undo began: a custody taken for a member that still stands goes back into its containers
			java.util.Set<String> ids = new java.util.LinkedHashSet<>(r.decCredit.keySet());
			ids.addAll(r.planIds);
			for (String id : ids) {
				Site s = Sites.get(id);
				ServerLevel lv = s == null ? null : Sites.levelOf(server, s);
				// (PSV fix round) by the custody held (a ledger fill marker without a phase takes custody too), not by the phase
				if (lv != null && Fills.holdsCustody(s) && Sites.pendingRecord(id) == null) {
					Fills.writeBack(lv, s);
				}
			}
		}
		if (r.stage == null) {
			boolean untouched = !result.removed() && r.undo == null && r.planned == null && r.current == null && r.undoSites.isEmpty() && r.restoredCells == 0
				&& r.decStock.isEmpty() // (v0.77.0 fix a2) a crate's stock taken: its cell was written
				&& result.restored() == 0 && result.handedDown().isEmpty() && !dev.larattalabs.architect.region.RegionFluids.drainStarted(r.group);
			if (untouched) {
				UNTOUCHED.add(r.group);
			} else {
				UNTOUCHED.remove(r.group);
			}
			Stop stop = decided ? null : stopOf(result, untouched); // (slice T4c) never PARTIAL once decided
			if (stop == null) {
				LAST_STOP.remove(r.group);
			} else {
				LAST_STOP.put(r.group, stop);
			}
			SiteGroupRec eg = Sites.group(r.group);
			signalEnd(eg == null ? null : eg.owner(), r.group);
		}
		STALLED.removeIf(x -> x.group.equals(r.group) && java.util.Objects.equals(x.stage, r.stage));
		r.heldDecided = decided;
		r.backoff = decided ? (r.backoff == 0 ? HELD_RETRY : Math.min(r.backoff * 2, HELD_RETRY_MAX)) : 0;
		r.retryAt = decided ? tick + r.backoff : 0;
		if (decided || stallsAtEnd(r, result.removed())) {
			STALLED.add(r); // (6c X, C22) restorations are still pending, or (v0.77.0 fix a2) a crate's stock is carried: the retry resumes them
			if (r.undo == null) {
				Architect.LOGGER.warn("Removal of group {}: ended before its undo holding a crate's stock {}; it stays stalled (the stock saved with it) "
					+ "until a retry", r.group, r.decStock);
			}
		}
		long t0 = System.nanoTime();
		SiteGroupRec g = decided ? null : Sites.group(r.group); // (slice T4c) held: its group stays as it is until it finishes
		if (g != null) {
			if (r.stage != null) {
				if (result.removed()) {
					Batches.setStage(server, g, r.stage, Stage.State.UNDONE);
				}
			} else {
				SiteGroupRec n = g.withState(result.removed() ? SiteGroupRec.REMOVED : SiteGroupRec.ACTIVE);
				java.util.LinkedHashMap<String, Stage.State> states = new java.util.LinkedHashMap<>();
				if (result.removed()) {
					// stages that never placed are skipped; placed ones are undone
					for (SiteGroupRec.StageRec st : n.stages()) {
						if (st.state() == Stage.State.PLACED || st.state() == Stage.State.PARTIAL) {
							states.put(st.name(), Stage.State.UNDONE);
						} else if (!st.state().terminal()) {
							states.put(st.name(), Stage.State.SKIPPED);
						}
					}
				}
				Batches.setStages(server, n, states); // one save for the group and its stages (phase 6a)
			}
		}
		Placement.lap("end:stages", t0);
		t0 = System.nanoTime();
		Placement.save(server, false);
		Placement.lap("end:save", t0);
		t0 = System.nanoTime();
		Architect.LOGGER.info("{} {} of group {}: {}{}", r.stage == null ? "Removal" : "Undo of stage " + r.stage, result.removed() ? "done" : "stopped",
			r.group, result.removed() ? "all sites restored" : String.join("; ", result.blockers()), result.refund().isEmpty() ? "" : "; refund "
				+ result.refund());
		if (decided) {
			// (slice T4c) held(decided): the call fails SITE_BUSY held(decided); the removal goes on by itself (no region end, no PARTIAL)
			String why = "held(decided) " + (r.stage == null ? "the removal of group " + r.group : "the undo of stage " + r.stage + " of group " + r.group)
				+ ": it finishes by itself (" + String.join("; ", result.blockers()) + ")";
			Architect.LOGGER.warn("{}", why);
			r.futures.forEach(f -> f.completeExceptionally(new dev.larattalabs.architect.api.ArchitectRefused(dev.larattalabs.architect.api.Reason.SITE_BUSY,
				why, "held(decided)")));
			r.futures.clear();
			Placement.lap("end:futures", t0);
			return;
		}
		if (r.stage == null) {
			groupEnded(r.group, result); // (C23) before the futures: a resumed removal has none
		}
		r.futures.forEach(f -> f.complete(result));
		if (result.removed()) {
			// (slice T4c) one path for consumers: every finished group or stage removal, a held decided one's later end included
			dev.larattalabs.architect.apiimpl.ApiEvents.removalFinished(r.group, r.stage, r.revisionId, result);
		}
		Placement.lap("end:futures", t0);
	}

	/**
	 * (slice PSVLC3, P1 1) A removal ending before its undo: a crate stock recorded for a crate that still stands was never taken (or its take
	 * never reached the disk): the record goes, the stock stays in the crate. Only a stock whose crate is gone keeps the removal stalled.
	 */
	private static void voidStanding(MinecraftServer server, Removal r) {
		for (String id : List.copyOf(r.decStock.keySet())) {
			Site s = Sites.get(id);
			ServerLevel lv = s == null ? null : Sites.levelOf(server, s);
			if (lv != null && s.construction() != null && Builder.crateStands(lv, s)) {
				r.decStock.remove(id);
				r.decItems.remove(id);
				r.decAt.remove(id);
			}
		}
	}

	/**
	 * (6c X, C22) Whether a removal that ends stays in {@link #STALLED} (kept in the queue file, its members sealed) for a retry to resume:
	 * its restorations are still pending; or (v0.77.0 fix a2) it ends before its undo holding a legacy crate's stock ({@link Removal#decStock}:
	 * a pre-save failed, the plan was dropped, then the rescan refused). That stock can't be given back safely: prepareDeconstruct restores the
	 * crate's cell as it takes the stock (the crate is gone; putting one back would write outside the journal), and a crate's stock never comes
	 * from a stockpile. Stalled, it stays saved with the removal and a retry carries it into the deconstruct items once ({@link #withStock}).
	 */
	static boolean stallsAtEnd(Removal r, boolean removed) {
		if (removed) {
			return false;
		}
		if (r.undo == null) {
			return !r.decStock.isEmpty();
		}
		return r.undoSites.stream().anyMatch(id -> Sites.pendingRecord(id) != null || Infras.pending(id) != null);
	}

	// ------------------------------------------------------------------ persistence

	static JsonArray toJson() {
		JsonArray a = new JsonArray();
		REMOVALS.forEach(r -> a.add(r.toJson()));
		STALLED.forEach(r -> {
			JsonObject o = r.toJson();
			o.addProperty("stalled", true);
			a.add(o);
		});
		return a;
	}

	static void load(JsonArray a) {
		REMOVALS.clear();
		STALLED.clear();
		LAST_STOP.clear(); // (S-DRS-1) a world's stops are its own
		for (JsonElement e : a) {
			try {
				Removal rm = Removal.fromJson(e.getAsJsonObject());
				writeAgainIn(rm);
				(e.getAsJsonObject().has("stalled") ? STALLED : REMOVALS).add(rm);
			} catch (RuntimeException ex) {
				Architect.LOGGER.warn("Could not read a group removal {}", e, ex);
			}
		}
		writeAgainDone();
	}

	/** The queue loaded: the members to write again are taken (UMT calls it after its own load). */
	static void writeAgainDone() {
		WRITE_AGAIN.clear();
	}

	/**
	 * (F6, undo hardening A) Members whose restore a removal in the queue had written, but whose writes the stop lost (the world-start
	 * settle found them standing: {@link Sites#reconcile}, which runs before the queue loads). Their removal writes them again (roll
	 * forward) instead of the settle taking them back while the removal still writes the others.
	 */
	private static final java.util.Set<String> WRITE_AGAIN = new java.util.HashSet<>();

	static void writeAgain(String siteId) {
		WRITE_AGAIN.add(siteId);
	}

	/** A loaded removal takes its members in {@link #WRITE_AGAIN} back into its sites, first (they were written first). */
	static void writeAgainIn(Removal r) {
		if (r.undo == null) {
			return; // planned: resumeCommitted takes back every planned site it lacks
		}
		List<String> again = new ArrayList<>();
		for (String id : r.undoSites) {
			if (WRITE_AGAIN.contains(id) && !r.sites.contains(id)) {
				again.add(id);
			}
		}
		if (!again.isEmpty()) {
			r.sites.addAll(0, again);
			Architect.LOGGER.info("Removal of group {}: {} written again (their restore's writes were lost at the stop)", r.group, again);
		}
	}

	/** Whether a group or stage removal is still in progress (planning, committing or writing). */
	static boolean removing() {
		return !REMOVALS.isEmpty();
	}

	static void reset(MinecraftServer server) {
		written.clear();
		REMOVALS.forEach(r -> r.futures.forEach(f -> f.completeExceptionally(new IllegalStateException("the world stopped"))));
		REMOVALS.clear();
		STALLED.clear();
		LAST_STOP.clear(); // (S-DRS-1) a world's stops are its own
		tick = 0;
	}
}
