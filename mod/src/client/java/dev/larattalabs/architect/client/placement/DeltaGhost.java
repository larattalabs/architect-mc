package dev.larattalabs.architect.client.placement;

import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.placement.CompositeMesh;
import dev.larattalabs.architect.site.SiteDeltas;
import dev.larattalabs.architect.survival.SiteNet;
import dev.larattalabs.architect.ui.Guard;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.core.BlockPos;

/**
 * The delta ghost (docs/CONTRACT.md phase 5b "Preview and UI"): a site's update shown before it is applied, its cells in 4c's
 * ADDED, REMOVED and CHANGED styles plus KEPT (the player's blocks a KEEP delta leaves). The server computes the world delta
 * ({@code Sites.checkDelta}) and sends it as {@code architect_mc:delta_preview}; the client draws it as a composite under the
 * caller's key. Client thread (the check runs on the integrated server).
 */
public final class DeltaGhost {
	private DeltaGhost() {
	}

	public static void init() {
		ClientPlayNetworking.registerGlobalReceiver(SiteNet.DeltaPreview.TYPE, (p, ctx) -> Guard.run("placement.delta", () -> accept(p)));
	}

	/** Asks the server for the delta ghost of {@code siteId} going to {@code toVersion} (0 = the head); it arrives under {@code key}. */
	public static CompletableFuture<SiteDeltas.Check> request(String key, String siteId, int toVersion) {
		return ServerTasks.callAsPlayer((level, player) -> {
			SiteDeltas.Check c = SiteDeltas.check(level, new SiteDeltas.Request(siteId, toVersion, dev.larattalabs.architect.delta.DeltaPlanner.Edits.KEEP,
				false, null, true));
			ServerPlayNetworking.send(player, SiteNet.DeltaPreview.of(key, siteId, c.to(), c.ghost()));
			return c;
		});
	}

	/** Draws a received delta ghost: one cell layer per kind (an empty one clears the key). */
	static void accept(SiteNet.DeltaPreview p) {
		if (p.keys().length == 0) {
			CompositePreview.clear(p.key());
			return;
		}
		int[] lo = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE};
		int[] hi = {Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
		List<List<long[]>> kinds = List.of(new ArrayList<>(), new ArrayList<>(), new ArrayList<>(), new ArrayList<>());
		for (int i = 0; i < p.keys().length; i++) {
			for (int j = 0; j < p.cells().get(i).length; j++) {
				long pos = Sections.pos(p.keys()[i], p.cells().get(i)[j]);
				int k = p.kinds().get(i)[j];
				if (k >= 0 && k < 4) {
					kinds.get(k).add(new long[] {pos});
				}
				int[] c = {BlockPos.getX(pos), BlockPos.getY(pos), BlockPos.getZ(pos)};
				for (int a = 0; a < 3; a++) {
					lo[a] = Math.min(lo[a], c[a]);
					hi[a] = Math.max(hi[a], c[a]);
				}
			}
		}
		CompositeMesh.Style[] styles = {CompositeMesh.Style.ADDED, CompositeMesh.Style.REMOVED, CompositeMesh.Style.CHANGED, CompositeMesh.Style.KEPT};
		List<CompositePreview.CellLayer> layers = new ArrayList<>();
		BlockPos origin = new BlockPos(lo[0], lo[1], lo[2]);
		for (int k = 0; k < 4; k++) {
			List<long[]> cs = kinds.get(k);
			if (cs.isEmpty()) {
				continue;
			}
			int[] xyz = new int[cs.size() * 3];
			int[] argb = new int[cs.size()];
			for (int i = 0; i < cs.size(); i++) {
				long pos = cs.get(i)[0];
				xyz[i * 3] = BlockPos.getX(pos) - lo[0];
				xyz[i * 3 + 1] = BlockPos.getY(pos) - lo[1];
				xyz[i * 3 + 2] = BlockPos.getZ(pos) - lo[2];
				argb[i] = 0xFFD8D8D8;
			}
			layers.add(new CompositePreview.CellLayer("delta:" + p.siteId() + "@" + p.to() + ":" + styles[k].name().toLowerCase(java.util.Locale.ROOT),
				styles[k], origin, hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1, xyz, argb));
		}
		CompositePreview.showCells(p.key(), layers);
	}
}
