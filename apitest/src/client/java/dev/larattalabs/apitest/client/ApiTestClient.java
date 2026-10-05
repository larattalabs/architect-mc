package dev.larattalabs.apitest.client;

import com.google.gson.JsonObject;
import dev.larattalabs.apitest.ApiTest;
import dev.larattalabs.architect.api.ArchitectClientApi;
import dev.larattalabs.architect.api.PreviewStyle;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/** The client half of apitest: runs {@code /apitest preview ...} requests through {@link ArchitectClientApi} on the client thread. */
public class ApiTestClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		ClientTickEvents.END_CLIENT_TICK.register(mc -> {
			String[] p = ApiTest.PREVIEW.getAndSet(null);
			if (p == null) {
				return;
			}
			JsonObject o = new JsonObject();
			try {
				if (p[0].equals("clear")) {
					ArchitectClientApi.get().clearPreview();
				} else {
					ArchitectClientApi.get().preview(p[0], new BlockPos(Integer.parseInt(p[1]), Integer.parseInt(p[2]), Integer.parseInt(p[3])),
						Rotation.values()[p.length > 4 ? Integer.parseInt(p[4]) : 0], PreviewStyle.GHOST);
				}
				o.addProperty("previewing", ArchitectClientApi.get().previewing());
			} catch (RuntimeException e) {
				o.addProperty("error", e.toString());
			}
			o.addProperty("thread", Thread.currentThread().getName());
			ApiTest.RESULTS.put("preview", o);
		});
	}
}
