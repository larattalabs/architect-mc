package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.CompositeInfo;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.Blueprints;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * (7c CM-b) Composites in the world (docs/CONTRACT.md "Phase 7c" §3 row 6): a composite library entry ({@link CompositeInfo} in its ext,
 * the module offsets in its {@code <id>.composite.json} manifest, CM-a's kit output) is placed as ONE site group: each module an ordinary
 * BOX site of its hidden module entry, one stage per module (named by the module id) in support order, LAYER on the shared seams. The
 * group's id is the composite placement's handle: {@code Sites.remove(groupId)} removes the whole, {@code undoStage(groupId, module)}
 * one module. A composite union is never placed as one plain site ({@link #unionRefusal}).
 *
 * <p>Crash safety comes from the batch and group machinery the modules ride on: the batch is in the queue file, each module item is a
 * journaled placement, a group removal is a journaled Removal. Kill point {@code CM1}: a module's item is placed and the queue file is
 * written, the next module not started.
 */
public final class Composites {
	/** The batch and group ext key that marks a composite placement: {@code {entry, modules: [moduleId...]}}. */
	public static final String EXT_SITE = "architect_mc:compositeSite";
	/** The module entry ids are {@code <composite>__<module>} (CM-a's {@code moduleEntryId}). */
	public static final String MODULE_SEP = "__";
	/** A module entry's sidecar marks it hidden: its composite's entry id (top level, not ext; written by the sidecar's install). */
	public static final String COMPOSITE_OF = "compositeOf";
	/** The joint port kind (the kit's {@code JOINT_KIND}). */
	public static final String JOINT_KIND = "architect:joint";

	private Composites() {
	}

	/** One module: its id in the composite, its hidden entry, its min corner in the union and its size. */
	public record Module(String id, String entryId, int ax, int ay, int az, int sx, int sy, int sz) {
		/** Its box in union coordinates. */
		public Anchors.Bounds unionBox() {
			return new Anchors.Bounds(ax, ay, az, ax + sx - 1, ay + sy - 1, az + sz - 1);
		}
	}

	/** A composite entry read for placement: the union size, the modules in support order, the joints. */
	public record Layout(String entryId, int sx, int sy, int sz, List<Module> modules, List<CompositeInfo.Joint> joints) {
		public @Nullable Module module(String entryIdOrId) {
			for (Module m : modules) {
				if (m.entryId().equals(entryIdOrId) || m.id().equals(entryIdOrId)) {
					return m;
				}
			}
			return null;
		}
	}

	/** A refusal of a composite before anything is placed. */
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

	// ------------------------------------------------------------------ reading

	/** Whether the library entry is a composite (its ext carries a well-formed CompositeInfo). Any thread. */
	public static boolean isComposite(@Nullable String entryId) {
		Blueprints.Entry e = entryId == null ? null : Blueprints.entry(entryId);
		return e != null && info(e.json()) != null;
	}

	/** Whether the library entry is a composite's hidden module entry. Any thread. */
	public static boolean isModule(@Nullable JsonObject json) {
		return json != null && json.has(COMPOSITE_OF) && json.get(COMPOSITE_OF).isJsonPrimitive();
	}

	static @Nullable CompositeInfo info(@Nullable JsonObject sidecar) {
		if (sidecar == null || !(sidecar.get("ext") instanceof JsonObject ext)) {
			return null;
		}
		return CompositeInfo.ofExt(ext).orElse(null);
	}

	/**
	 * The refusal for placing a composite union as one plain site (the UI, a command, a batch item, a fit), or null: a composite is placed
	 * only through {@code Sites.place} of its entry, which places its modules.
	 */
	public static @Nullable String unionRefusal(String blueprintId) {
		Blueprints.Entry e = Blueprints.entry(blueprintId);
		CompositeInfo ci = e == null ? null : info(e.json());
		if (ci == null) {
			return null;
		}
		return blueprintId + " is a composite (" + ci.moduleEntryIds().size() + " modules, " + (ci.union().getXSpan()) + "x" + ci.union().getYSpan() + "x"
			+ ci.union().getZSpan() + "): it is placed only through Sites.place of the composite entry, which places its modules as one site group";
	}

	/** The layout of a composite library entry, or null when the entry is not a composite. */
	public static @Nullable Layout layout(String entryId) throws Refused {
		Blueprints.Entry e = Blueprints.entry(entryId);
		if (e == null) {
			return null;
		}
		CompositeInfo ci = info(e.json());
		if (ci == null) {
			return null;
		}
		JsonObject manifest = null;
		if (e.dir() != null) {
			Path f = e.dir().resolve(entryId + ".composite.json");
			try {
				if (Files.isRegularFile(f)) {
					manifest = JsonParser.parseString(Files.readString(f)).getAsJsonObject();
				}
			} catch (Exception x) {
				throw new Refused(Reason.OTHER, "composite " + entryId + ": its manifest " + f.getFileName() + " can't be read (" + x.getMessage() + ")");
			}
		}
		if (manifest == null) {
			throw new Refused(Reason.OTHER, "composite " + entryId + ": its manifest " + entryId + ".composite.json is missing from its library folder");
		}
		return layout(entryId, ci, manifest, id -> {
			Blueprints.Entry m = Blueprints.entry(id);
			return m == null ? null : m.json();
		});
	}

	/**
	 * The layout from the entry's CompositeInfo, its manifest and the module entries' sidecars ({@code sidecarOf}: null for a missing
	 * entry). Pure (units). Refuses a missing module entry ({@link Reason#UNKNOWN_BLUEPRINT}) and a manifest that disagrees with the
	 * CompositeInfo or a module's size ({@link Reason#OTHER}).
	 */
	public static Layout layout(String entryId, CompositeInfo ci, JsonObject manifest, Function<String, @Nullable JsonObject> sidecarOf) throws Refused {
		int[] us = size(manifest.get("size"));
		if (us == null) {
			throw new Refused(Reason.OTHER, "composite " + entryId + ": its manifest has no size");
		}
		Map<String, JsonObject> byEntry = new LinkedHashMap<>();
		if (manifest.get("modules") instanceof JsonArray ms) {
			for (JsonElement el : ms) {
				if (el instanceof JsonObject m && m.has("entryId")) {
					byEntry.put(m.get("entryId").getAsString(), m);
				}
			}
		}
		List<Module> mods = new ArrayList<>();
		for (String eid : ci.moduleEntryIds()) {
			JsonObject m = byEntry.get(eid);
			if (m == null || !(m.get("at") instanceof JsonArray at) || at.size() != 3) {
				throw new Refused(Reason.OTHER, "composite " + entryId + ": its manifest does not place module " + eid);
			}
			String mid = m.has("id") ? m.get("id").getAsString() : eid;
			JsonObject side = sidecarOf.apply(eid);
			if (side == null) {
				throw new Refused(Reason.UNKNOWN_BLUEPRINT, "composite " + entryId + ": module " + mid + " (" + eid + ") is not in the library");
			}
			int[] s = size(side.get("size"));
			int[] ms2 = size(m.get("size"));
			if (s == null || ms2 != null && (s[0] != ms2[0] || s[1] != ms2[1] || s[2] != ms2[2])) {
				throw new Refused(Reason.OTHER, "composite " + entryId + ": module " + mid + " (" + eid + ") is not the size its manifest records");
			}
			Module mod = new Module(mid, eid, at.get(0).getAsInt(), at.get(1).getAsInt(), at.get(2).getAsInt(), s[0], s[1], s[2]);
			if (mod.ax() < 0 || mod.ay() < 0 || mod.az() < 0 || mod.ax() + mod.sx() > us[0] || mod.ay() + mod.sy() > us[1] || mod.az() + mod.sz() > us[2]) {
				throw new Refused(Reason.OTHER, "composite " + entryId + ": module " + mid + " leaves the union box");
			}
			mods.add(mod);
		}
		if (mods.isEmpty()) {
			throw new Refused(Reason.OTHER, "composite " + entryId + " has no modules");
		}
		return new Layout(entryId, us[0], us[1], us[2], supportOrder(mods), ci.joints());
	}

	private static int @Nullable [] size(@Nullable JsonElement s) {
		if (s instanceof JsonObject o && o.has("x") && o.has("y") && o.has("z")) {
			return new int[] {o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt()};
		}
		if (s instanceof JsonArray a && a.size() == 3) {
			return new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
		}
		return null;
	}

	/**
	 * Support order (CompositeInfo's javadoc: a module that rests on another follows it): B follows A when B starts above A's bottom and
	 * at or below A's top (B's floor on A's top layer, a shared seam, or B's box above it) and their footprints overlap. Otherwise the
	 * listed order. Stable; a cycle cannot happen (the relation follows strictly increasing min y).
	 */
	public static List<Module> supportOrder(List<Module> in) {
		List<Module> out = new ArrayList<>();
		List<Module> left = new ArrayList<>(in);
		while (!left.isEmpty()) {
			Module pick = null;
			for (Module b : left) {
				boolean waits = false;
				for (Module a : left) {
					if (a != b && restsOn(b, a)) {
						waits = true;
						break;
					}
				}
				if (!waits) {
					pick = b;
					break;
				}
			}
			if (pick == null) {
				pick = left.get(0);
			}
			out.add(pick);
			left.remove(pick);
		}
		return out;
	}

	static boolean restsOn(Module b, Module a) {
		boolean footprint = b.ax() <= a.ax() + a.sx() - 1 && a.ax() <= b.ax() + b.sx() - 1 && b.az() <= a.az() + a.sz() - 1 && a.az() <= b.az() + b.sz() - 1;
		return footprint && b.ay() > a.ay();
	}

	// ------------------------------------------------------------------ joints

	/**
	 * The joints checked against the module entries' own ports (CM-a's rules, at place time): each end a port of kind
	 * {@code architect:joint} on its module, on its module's boundary face in its facing, both ends at the same union cell, opposite
	 * facings, the same width and height. The first problem refuses {@link Reason#JOINT_MISMATCH}, naming the module and the port.
	 * Pure (units).
	 */
	public static void checkJoints(Layout l, Function<String, @Nullable JsonObject> sidecarOf) throws Refused {
		for (CompositeInfo.Joint j : l.joints()) {
			Module a = l.module(j.fromModule());
			Module b = l.module(j.toModule());
			if (a == null) {
				throw new Refused(Reason.JOINT_MISMATCH, "composite " + l.entryId() + ": joint " + j.fromModule() + "." + j.fromPort() + " names a module the composite does not have");
			}
			if (b == null) {
				throw new Refused(Reason.JOINT_MISMATCH, "composite " + l.entryId() + ": joint " + j.toModule() + "." + j.toPort() + " names a module the composite does not have");
			}
			JsonObject pa = port(sidecarOf.apply(a.entryId()), j.fromPort());
			JsonObject pb = port(sidecarOf.apply(b.entryId()), j.toPort());
			String bad = endProblem(a, j.fromPort(), pa);
			if (bad == null) {
				bad = endProblem(b, j.toPort(), pb);
			}
			if (bad == null) {
				int[] ca = {pa.get("x").getAsInt() + a.ax(), pa.get("y").getAsInt() + a.ay(), pa.get("z").getAsInt() + a.az()};
				int[] cb = {pb.get("x").getAsInt() + b.ax(), pb.get("y").getAsInt() + b.ay(), pb.get("z").getAsInt() + b.az()};
				String fa = pa.get("facing").getAsString();
				String fb = pb.get("facing").getAsString();
				if (ca[0] != cb[0] || ca[1] != cb[1] || ca[2] != cb[2]) {
					bad = "module " + b.id() + " port " + j.toPort() + " is at union cell " + cb[0] + "," + cb[1] + "," + cb[2] + ", not at module " + a.id() + " port "
						+ j.fromPort() + "'s cell " + ca[0] + "," + ca[1] + "," + ca[2];
				} else if (!BlueprintTransform.rotateDirection(fa, 2).equals(fb)) {
					bad = "module " + b.id() + " port " + j.toPort() + " faces " + fb + ", not opposite module " + a.id() + " port " + j.fromPort() + " (" + fa + ")";
				} else if (dim(pa, "width") != dim(pb, "width")) {
					bad = "module " + b.id() + " port " + j.toPort() + " is " + dim(pb, "width") + " wide, module " + a.id() + " port " + j.fromPort() + " " + dim(pa, "width");
				} else if (dim(pa, "height") != dim(pb, "height")) {
					bad = "module " + b.id() + " port " + j.toPort() + " is " + dim(pb, "height") + " tall, module " + a.id() + " port " + j.fromPort() + " " + dim(pa, "height");
				}
			}
			if (bad != null) {
				throw new Refused(Reason.JOINT_MISMATCH, "composite " + l.entryId() + ": " + bad);
			}
		}
	}

	private static int dim(JsonObject p, String k) {
		return p.has(k) ? p.get(k).getAsInt() : 1;
	}

	private static @Nullable JsonObject port(@Nullable JsonObject sidecar, String name) {
		if (sidecar == null || !(sidecar.get("ports") instanceof JsonArray ps)) {
			return null;
		}
		for (JsonElement e : ps) {
			if (e instanceof JsonObject p && p.has("name") && name.equals(p.get("name").getAsString())) {
				return p;
			}
		}
		return null;
	}

	/** One end's own problem: missing, not a joint, malformed, or off its module's boundary face; null when fine. */
	private static @Nullable String endProblem(Module m, String portName, @Nullable JsonObject p) {
		String who = "module " + m.id() + " port " + portName;
		if (p == null) {
			return who + " does not exist";
		}
		if (!p.has("kind") || !JOINT_KIND.equals(p.get("kind").getAsString())) {
			return who + " is not an " + JOINT_KIND + " port";
		}
		if (!p.has("x") || !p.has("y") || !p.has("z") || !p.has("facing")) {
			return who + " is malformed";
		}
		int x = p.get("x").getAsInt();
		int z = p.get("z").getAsInt();
		boolean edge = switch (p.get("facing").getAsString()) {
			case "north" -> z == 0;
			case "south" -> z == m.sz() - 1;
			case "west" -> x == 0;
			case "east" -> x == m.sx() - 1;
			default -> false;
		};
		return edge ? null : who + " is not on its module's " + p.get("facing").getAsString() + " face";
	}

	// ------------------------------------------------------------------ geometry

	/**
	 * A module's placement origin (its rotated template's min corner in the world) when the composite union is placed with its rotated
	 * min corner at {@code (ox, oy, oz)} and {@code turns} clockwise quarter turns: the union's template-to-world map applied to the
	 * module's box ({@link BlueprintTransform#boxToWorld}). Pure (units).
	 */
	public static int[] moduleOrigin(Layout l, Module m, int turns, int ox, int oy, int oz) {
		Anchors.Bounds w = BlueprintTransform.boxToWorld(m.unionBox(), l.sx(), l.sz(), turns, ox, oy, oz);
		return new int[] {w.minX(), w.minY(), w.minZ()};
	}

	// ------------------------------------------------------------------ the batch it rides on

	/** Whether a batch is a composite placement's. */
	public static boolean isCompositeBatch(@Nullable QBatch b) {
		return b != null && b.ext.has(EXT_SITE);
	}

	/** The composite group's entry id, or null when the group is not a composite placement's. */
	public static @Nullable String groupEntry(@Nullable SiteGroupRec g) {
		if (g == null || !(g.ext().get(EXT_SITE) instanceof JsonObject o) || !o.has("entry")) {
			return null;
		}
		return o.get("entry").getAsString();
	}

	/** The futures waiting on a composite batch (its {@code Sites.place}): completed by {@link #batchDone}. Server thread. */
	private static final Map<String, CompletableFuture<QBatch>> WAITING = new HashMap<>();
	/** Batches whose rollback was started (once). Server thread. */
	private static final Set<String> ROLLED = new java.util.HashSet<>();

	/** A future completed when the composite batch ends (DONE, or a failure rolled back). Server thread. */
	public static CompletableFuture<QBatch> whenDone(String batchId) {
		return WAITING.computeIfAbsent(batchId, k -> new CompletableFuture<>());
	}

	/**
	 * TEST kill point CM1 ({@code dev.journal.killAt}): a composite module's item is placed and the queue file is written (flushed), the
	 * next module not started. Called by {@link Batches#placedItem}.
	 */
	static void modulePlaced(QBatch b) {
		if (!isCompositeBatch(b)) {
			return;
		}
		String armed = dev.larattalabs.architect.journal.WorldJournal.armed();
		if (armed == null || !armed.startsWith("CM1")) {
			return;
		}
		if (b.items.stream().noneMatch(i -> !i.status.terminal())) {
			return; // the last module: not between two
		}
		Placement.flushSaves();
		dev.larattalabs.architect.journal.WorldJournal.kill("CM1");
	}

	/**
	 * A composite batch ended (Batches.finish). DONE with every module placed: the waiting place completes. Anything else (a module
	 * failed, the batch was cancelled or stopped) is rolled back: the group is removed whole (journaled; it resumes after a crash), then
	 * the waiting place completes. A group already being removed is left to that removal. Also runs for a batch resumed after a restart,
	 * with no one waiting. The decision is taken in the next server task, so a cancel that a group removal started is seen as such.
	 */
	static void batchDone(MinecraftServer server, QBatch b) {
		if (!isCompositeBatch(b)) {
			return;
		}
		boolean all = b.status == QBatch.Status.DONE && b.items.stream().allMatch(i -> i.status == QItem.Status.PLACED);
		if (all) {
			CompletableFuture<QBatch> f = WAITING.remove(b.id);
			if (f != null) {
				f.complete(b);
			}
			return;
		}
		server.execute(() -> {
			SiteGroupRec g = Sites.group(b.group);
			boolean removing = g == null || !SiteGroupRec.ACTIVE.equals(g.state()) || Groups.removalRunning(b.group);
			if (removing || !ROLLED.add(b.id)) {
				CompletableFuture<QBatch> f = WAITING.remove(b.id);
				if (f != null) {
					f.complete(b);
				}
				return;
			}
			Architect.LOGGER.info("Composite {} (group {}): batch {} ended {} with a module not placed: rolling the placed modules back", groupEntry(g), b.group,
				b.id, b.status.name().toLowerCase(java.util.Locale.ROOT));
			Groups.removeGroup(server, b.group, b.owner, true, Sites.Covered.KEEP).whenComplete((r, t) -> {
				if (t != null || r == null || !r.removed()) {
					Architect.LOGGER.warn("Composite group {}: the rollback did not finish ({})", b.group, t != null ? t.toString() : r == null ? "no result"
						: String.join("; ", r.blockers()));
				}
				CompletableFuture<QBatch> f = WAITING.remove(b.id);
				if (f != null) {
					f.complete(b);
				}
			});
		});
	}

	/** World stop: nothing waits any more. */
	static void reset() {
		WAITING.values().forEach(f -> f.cancel(false));
		WAITING.clear();
		ROLLED.clear();
	}
}
