package dev.larattalabs.architect.site;

import dev.larattalabs.architect.api.CellWrite;
import dev.larattalabs.architect.api.CellsRequest;
import dev.larattalabs.architect.api.Layer;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.RoadRequest;
import dev.larattalabs.architect.api.Verdict;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.WorldJournal;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/** The 1.5.0 API's roads, cell sites and stack query over {@link InfraPlace} (internal: {@code apiimpl} calls it). Server thread. */
public final class InfraApi {
	private InfraApi() {
	}

	private static Verdict verdict(InfraPlace.Check c, List<Refusal> extra) {
		List<Refusal> refusals = new ArrayList<>(extra);
		c.refusals().forEach(r -> refusals.add(new Refusal(r.reason(), r.message())));
		var box = Optional.ofNullable(c.box()).map(dev.larattalabs.architect.apiimpl.Views::box);
		List<dev.larattalabs.architect.api.Overlap> overlaps = new ArrayList<>();
		java.util.Map<String, Integer> by = new java.util.LinkedHashMap<>();
		c.overlaps().forEach(h -> by.merge(h.site(), h.cells(), Integer::sum));
		boolean blocking = !refusals.isEmpty() && refusals.stream().anyMatch(r -> r.reason() == Reason.OVERLAP || r.reason() == Reason.OVERLAP_BUSY
			|| r.reason() == Reason.OVERLAP_OWNED || r.reason() == Reason.LAYER_DEPTH);
		by.forEach((s, n) -> overlaps.add(new dev.larattalabs.architect.api.Overlap(s, Sites.ownerOf(s), n, blocking)));
		return new Verdict(refusals, c.notes(), false, Map.of(), box, box, overlaps, c.cells());
	}

	private static InfraPlace.Check road(RoadRequest r) {
		return InfraPlace.checkRoad(r.level(), r.points(), r.width(), r.surface(), r.slab(), r.lanterns(), r.shallowDecks(), r.owner(), r.force());
	}

	public static Verdict checkRoad(RoadRequest r) {
		String mode = InfraPlace.modeRefusal(r.level().getServer(), r.mode(), r.actor(), false);
		if (mode != null) {
			return verdict(new InfraPlace.Check(List.of(), List.of(), new long[0], new Journal.Value[0], null, List.of(), null), List.of(new Refusal(
				Reason.NOT_ALLOWED, mode)));
		}
		return verdict(road(r), List.of());
	}

	public static CompletableFuture<PlaceResult> placeRoad(RoadRequest r) {
		String mode = InfraPlace.modeRefusal(r.level().getServer(), r.mode(), r.actor(), false);
		if (mode != null) {
			return CompletableFuture.completedFuture(new PlaceResult(false, Optional.empty(), List.of(new Refusal(Reason.NOT_ALLOWED, mode)), List.of()));
		}
		InfraPlace.Check c = road(r);
		return start(r.level(), c, () -> InfraPlace.beginRoad(r.level(), c, r.owner(), r.ext(), null));
	}

	private interface Begin {
		InfraJob begin() throws Sites.SiteException;
	}

	private static CompletableFuture<PlaceResult> start(ServerLevel level, InfraPlace.Check c, Begin b) {
		if (!c.ok()) {
			return CompletableFuture.completedFuture(new PlaceResult(false, Optional.empty(), c.refusals().stream().map(x -> new Refusal(x.reason(),
				x.message())).toList(), c.notes()));
		}
		try {
			InfraJob job = b.begin();
			CompletableFuture<PlaceResult> f = new CompletableFuture<>();
			job.futures.add(f);
			Placement.add(level.getServer(), job);
			return f;
		} catch (Sites.SiteException e) {
			return CompletableFuture.completedFuture(new PlaceResult(false, Optional.empty(), List.of(new Refusal(e.reason(), e.getMessage())), List.of()));
		}
	}

	private static InfraPlace.Check cells(CellsRequest r, boolean dryRun) {
		List<BlockPos> pos = new ArrayList<>(r.cells().size());
		List<BlockState> st = new ArrayList<>(r.cells().size());
		List<@Nullable CompoundTag> nbt = new ArrayList<>(r.cells().size());
		byte[] cond = null;
		int k = 0;
		for (CellWrite c : r.cells()) {
			pos.add(c.pos());
			st.add(c.state());
			nbt.add(c.nbt());
			if (c.cond() != null) {
				if (cond == null) {
					cond = new byte[r.cells().size()];
					java.util.Arrays.fill(cond, (byte) -1);
				}
				cond[k] = (byte) c.cond().ordinal();
			}
			k++;
		}
		return InfraPlace.protect(r.level(), InfraPlace.checkCells(r.level(), r.kind(), Journal.Policy.valueOf(r.policy().name()), pos, st, nbt, cond,
			r.naturalOnly(), r.overlap() == dev.larattalabs.architect.api.OverlapPolicy.LAYER, r.owner(), r.force(), dryRun), r.owner(), "The cell site");
	}

	public static Verdict checkCells(CellsRequest r) {
		String mode = InfraPlace.modeRefusal(r.level().getServer(), r.mode(), r.actor(), true);
		if (mode != null) {
			return verdict(new InfraPlace.Check(List.of(), List.of(), new long[0], new Journal.Value[0], null, List.of(), null), List.of(new Refusal(
				Reason.NOT_ALLOWED, mode)));
		}
		return verdict(cells(r, true), List.of());
	}

	public static CompletableFuture<PlaceResult> placeCells(CellsRequest r) {
		String mode = InfraPlace.modeRefusal(r.level().getServer(), r.mode(), r.actor(), true);
		if (mode != null) {
			return CompletableFuture.completedFuture(new PlaceResult(false, Optional.empty(), List.of(new Refusal(Reason.NOT_ALLOWED, mode)), List.of()));
		}
		InfraPlace.Check c = cells(r, false);
		return start(r.level(), c, () -> InfraPlace.beginCells(r.level(), r.kind(), Journal.Policy.valueOf(r.policy().name()), c, r.owner(), r.ext(),
			null));
	}

	public static CompletableFuture<Sites.Removed> remove(ServerLevel level, String id, Sites.Covered covered) throws Sites.SiteException {
		return InfraPlace.remove(level, id, covered);
	}

	/** The stack at a cell, bottom first. */
	public static List<Layer> stack(String dimension, BlockPos pos) {
		List<Layer> out = new ArrayList<>();
		try {
			List<WorldJournal.Layer> st = WorldJournal.stack(dimension, pos.asLong());
			for (int i = 0; i < st.size(); i++) {
				WorldJournal.Layer l = st.get(i);
				out.add(new Layer(l.meta().site(), l.meta().kind(), dev.larattalabs.architect.api.Policy.valueOf(l.meta().policy().name()), l.cell().layer(),
					i == st.size() - 1));
			}
		} catch (IOException e) {
			// the journal is unavailable: an empty stack
		}
		return out;
	}
}
