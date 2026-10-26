package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.launcher.Launcher;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/**
 * Slice SAFETY DevBridge hooks (the keys themselves: {@code dev.build.enter}, {@code dev.build.escape}, {@code dev.safety.undo},
 * and {@code dev.key {mapping: 'key.architect_mc.undo_last'}}).
 */
public final class SliceSafetyDev {
	private SliceSafetyDev() {
	}

	public static void init() {
		DevBridge.register("dev.safety.threshold", 10_000, "{blocks?: int >= 1} - (SAFETY) the big-placement threshold (confirmBlocks in "
			+ "config/architect_mc.json): set and saved when given -> {threshold}", (req, mc) -> {
				Fields f = Fields.of(req);
				Integer blocks = f.has("blocks") ? f.optInt("blocks", 1000, 1, 1_000_000_000) : null;
				return DevBridge.onClient(mc, () -> {
					if (blocks != null) {
						Launcher.setConfirmBlocks(blocks);
					}
					JsonObject o = new JsonObject();
					o.addProperty("threshold", Launcher.confirmBlocks());
					return o;
				});
			});
		DevBridge.register("dev.safety.placeOwned", 30_000, "{blueprint, origin: [x,y,z], owner} - (SAFETY) place a site as another mod does "
			+ "through the API (siteOwner set, the player as the actor; instant): never the undo key's -> {placed, siteId, message?}", (req, mc) -> {
				Fields f = Fields.of(req);
				String bpId = f.nonBlank("blueprint");
				String owner = f.nonBlank("owner");
				int[] o = dev.larattalabs.architect.client.placement.PlacementFeature.origin(f, "origin");
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					JsonObject out = new JsonObject();
					Blueprint bp = Blueprints.get(bpId);
					if (bp == null) {
						throw new DevBridge.DevException("no design " + bpId);
					}
					try {
						Site s = Sites.place(level, bp, new BlockPos(o[0], o[1], o[2]), Rotation.NONE, false, player.getUUID().toString(), false, owner, null,
							player);
						out.addProperty("placed", true);
						out.addProperty("siteId", s.id());
					} catch (Sites.SiteException e) {
						out.addProperty("placed", false);
						out.addProperty("message", e.getMessage());
					}
					return out;
				})).thenCompose(x -> x);
			});
	}
}
