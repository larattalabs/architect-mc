package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Batch;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.OverlapPolicy;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.Verdict;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Batches;
import dev.larattalabs.architect.site.Composites;
import dev.larattalabs.architect.site.EntranceStyle;
import dev.larattalabs.architect.site.SiteJournal;
import dev.larattalabs.architect.site.Sites;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * (7c CM-b) {@code Sites.place} and {@code Sites.check} of a composite entry ({@link Composites}): every check runs for every module before
 * anything is placed (nothing is placed when one refuses, and a module's refusal names it), then the modules are queued as one batch in a
 * new site group, one stage per module in support order, LAYER on the seams. The place completes when every module is placed, with
 * {@code siteId} = the group id (the handle {@code Sites.remove} takes for the whole), or refused after the placed modules were rolled back.
 * Server thread.
 */
final class CompositePlace {
	private CompositePlace() {
	}

	/** What the checks found: the refusals (named), the notes, the module verdicts' boxes. */
	private record Pre(Composites.@Nullable Layout layout, List<Refusal> refused, List<String> notes, Anchors.@Nullable Bounds box,
		Anchors.@Nullable Bounds snap, List<SiteJournal.Hit> overlaps) {
	}

	private static Pre pre(PlaceRequest r) {
		List<Refusal> refused = new ArrayList<>();
		String id = r.blueprintId();
		Composites.Layout l;
		try {
			l = Composites.layout(id);
		} catch (Composites.Refused e) {
			return new Pre(null, List.of(new Refusal(e.reason(), e.getMessage())), List.of(), null, null, List.of());
		}
		if (l == null) {
			return new Pre(null, List.of(new Refusal(Reason.UNKNOWN_BLUEPRINT, "No composite " + id + " in the library")), List.of(), null, null, List.of());
		}
		if (r.site() != null) {
			refused.add(new Refusal(Reason.OTHER, "composite " + id + " is not a site-bound design: place it without a site"));
		}
		// S-7c-6: composites stay out of survival in 7c (INSTANT only, a Patron's or creative)
		boolean survival = SurvivalWorld.on();
		if (ApiRules.construction(r.mode(), survival)) {
			refused.add(new Refusal(Reason.NOT_ALLOWED, "composite " + id + " (" + l.modules().size() + " modules) is not built as a construction site: composites stay"
				+ " out of survival in 7c; it places INSTANT only (a player with permission level 2 in a survival world)"));
		} else {
			String no = ApiRules.modeRefusal(r.mode(), survival, r.actor() != null, SitesImpl.permission2(r.actor()));
			if (no != null) {
				refused.add(new Refusal(Reason.NOT_ALLOWED, "composite " + id + ": " + no));
			}
		}
		try {
			Composites.checkJoints(l, CompositePlace::sidecar);
		} catch (Composites.Refused e) {
			refused.add(new Refusal(e.reason(), e.getMessage()));
		}
		if (!refused.isEmpty()) {
			return new Pre(l, refused, List.of(), null, null, List.of());
		}
		String badStyle = EntranceStyle.refusal(r.pathStyle());
		if (badStyle != null) {
			return new Pre(l, List.of(new Refusal(Reason.OTHER, badStyle)), List.of(), null, null, List.of());
		}
		boolean layer = r.overlap() == OverlapPolicy.LAYER;
		List<String> notes = new ArrayList<>();
		List<SiteJournal.Hit> overlaps = new ArrayList<>();
		Anchors.Bounds box = null;
		Anchors.Bounds snap = null;
		int turns = r.rotation().ordinal();
		for (Composites.Module m : l.modules()) {
			Blueprint bp = Blueprints.get(m.entryId());
			if (bp == null) {
				refused.add(new Refusal(Reason.UNKNOWN_BLUEPRINT, "module " + m.id() + " (" + m.entryId() + ") is not in the library"));
				continue;
			}
			int[] o = Composites.moduleOrigin(l, m, turns, r.origin().getX(), r.origin().getY(), r.origin().getZ());
			// against the world as it is (the request's own overlap policy); the seams between modules layer at placement
			Sites.Verdict v = Sites.verdict(r.level(), bp, new BlockPos(o[0], o[1], o[2]), r.rotation(), r.force(), null, true, false, layer, r.owner(),
				EntranceStyle.plain(r.pathStyle()));
			for (Sites.Refusal x : v.typed()) {
				refused.add(new Refusal(x.reason(), "module " + m.id() + " (" + m.entryId() + "): " + x.message(), x.builds()));
			}
			v.notes().forEach(n -> notes.add("module " + m.id() + ": " + n));
			overlaps.addAll(v.overlaps());
			box = join(box, v.box());
			snap = join(snap, v.snapshotBox());
		}
		return new Pre(l, refused, notes, box, snap, overlaps);
	}

	private static Anchors.@Nullable Bounds join(Anchors.@Nullable Bounds a, Anchors.@Nullable Bounds b) {
		if (a == null) {
			return b;
		}
		if (b == null) {
			return a;
		}
		return new Anchors.Bounds(Math.min(a.minX(), b.minX()), Math.min(a.minY(), b.minY()), Math.min(a.minZ(), b.minZ()), Math.max(a.maxX(), b.maxX()),
			Math.max(a.maxY(), b.maxY()), Math.max(a.maxZ(), b.maxZ()));
	}

	static @Nullable JsonObject sidecar(String entryId) {
		Blueprints.Entry e = Blueprints.entry(entryId);
		return e == null ? null : e.json();
	}

	/** {@code Sites.check} of a composite: every module's verdict, named, with the boxes joined. No bill: composites build INSTANT only. */
	static Verdict check(PlaceRequest r) {
		Pre p = pre(r);
		return new Verdict(p.refused(), p.notes(), false, Map.of(), Optional.ofNullable(p.box()).map(Views::box), Optional.ofNullable(p.snap()).map(Views::box),
			SitesImpl.overlaps(p.overlaps(), p.refused()), 0, List.of(), Map.of(), false);
	}

	/** {@code Sites.place} of a composite. Server thread. */
	static CompletableFuture<PlaceResult> place(MinecraftServer server, PlaceRequest r) {
		Pre p = pre(r);
		if (!p.refused().isEmpty()) {
			ApiEvents.placeFailed(r, p.refused());
			return CompletableFuture.completedFuture(new PlaceResult(false, Optional.empty(), p.refused(), List.of()));
		}
		Composites.Layout l = p.layout();
		List<Batch.Item> items = new ArrayList<>();
		List<Batch.StageSpec> stages = new ArrayList<>();
		JsonArray mods = new JsonArray();
		int turns = r.rotation().ordinal();
		for (Composites.Module m : l.modules()) {
			int[] o = Composites.moduleOrigin(l, m, turns, r.origin().getX(), r.origin().getY(), r.origin().getZ());
			// every module LAYER: a seam cell is written by both neighbours (the same block, CM-a's SEAM_CONFLICT rule)
			PlaceRequest mr = new PlaceRequest(m.entryId(), r.level(), new BlockPos(o[0], o[1], o[2]), r.rotation(), Mode.INSTANT, r.owner(), new JsonObject(),
				r.force(), r.actor(), OverlapPolicy.LAYER, r.pathStyle(), r.consent(), null);
			items.add(new Batch.Item(m.id(), mr, m.id(), List.of()));
			stages.add(new Batch.StageSpec(m.id(), List.of(m.id())));
			mods.add(m.id());
		}
		JsonObject ext = r.ext().deepCopy();
		JsonObject mark = new JsonObject();
		mark.addProperty("entry", l.entryId());
		mark.add("modules", mods);
		mark.addProperty("origin", r.origin().getX() + "," + r.origin().getY() + "," + r.origin().getZ());
		mark.addProperty("turns", turns);
		ext.add(Composites.EXT_SITE, mark);
		Batch spec = new Batch(null, r.owner(), ext, null, items, stages, Batch.WaitPolicy.DEFAULT, dev.larattalabs.architect.api.LoadPolicy.LOADED_ONLY, false,
			true, true, false, null, OverlapPolicy.LAYER, null);
		String bid;
		try {
			bid = Batches.queue(server, spec);
		} catch (RuntimeException e) {
			List<Refusal> no = List.of(new Refusal(Reason.OTHER, "composite " + l.entryId() + ": " + e.getMessage()));
			ApiEvents.placeFailed(r, no);
			return CompletableFuture.completedFuture(new PlaceResult(false, Optional.empty(), no, List.of()));
		}
		QBatch qb = Batches.get(bid);
		String group = qb.group;
		dev.larattalabs.architect.Architect.LOGGER.info("Composite {}: {} module(s) queued as batch {} in group {} (stages {})", l.entryId(), l.modules().size(), bid,
			group, l.modules().stream().map(Composites.Module::id).toList());
		return Composites.whenDone(bid).thenApply(b -> {
			if (b.items.stream().allMatch(i -> i.status == QItem.Status.PLACED)) {
				List<String> notes = new ArrayList<>(p.notes());
				notes.add("composite " + l.entryId() + ": group " + group + ", modules " + l.modules().stream().map(Composites.Module::id).toList());
				return new PlaceResult(true, Optional.of(group), List.of(), notes);
			}
			QItem f = b.items.stream().filter(i -> i.status == QItem.Status.FAILED).findFirst().orElse(null);
			Reason why = f == null || f.reason == null ? Reason.CANCELLED : reasonOf(f.reason);
			String msg = f == null ? "composite " + l.entryId() + ": its placement was " + b.status.name().toLowerCase(java.util.Locale.ROOT)
				: "module " + f.key + " (" + f.blueprint + "): " + f.message;
			List<Refusal> no = List.of(new Refusal(why, msg));
			ApiEvents.placeFailed(r, no);
			return new PlaceResult(false, Optional.empty(), no, List.of("the modules placed before it were rolled back (group " + group + " removed)"));
		});
	}

	private static Reason reasonOf(String name) {
		try {
			return Reason.valueOf(name);
		} catch (IllegalArgumentException e) {
			return Reason.OTHER;
		}
	}
}
