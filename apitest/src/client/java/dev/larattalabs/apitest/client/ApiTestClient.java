package dev.larattalabs.apitest.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.apitest.ApiTest;
import dev.larattalabs.apitest.ApiTestMassing;
import dev.larattalabs.architect.api.ArchitectClientApi;
import dev.larattalabs.architect.api.PreviewLayer;
import dev.larattalabs.architect.api.PreviewStyle;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/**
 * The client half of apitest: runs {@code /apitest preview ...} and {@code /apitest composite ...} requests through
 * {@link ArchitectClientApi} on the client thread.
 */
public class ApiTestClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		ClientTickEvents.END_CLIENT_TICK.register(mc -> {
			preview();
			for (String[] c; (c = ApiTestMassing.COMPOSITE.poll()) != null;) {
				composite(c);
			}
		});
	}

	private static void preview() {
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
	}

	/** {"set", key, base64 [{blueprintId, origin: [x,y,z], rotation?: 0-3, style, onlyCells?: [[x,y,z]..]}]} or {"clear", key}. */
	private static void composite(String[] c) {
		JsonObject o = new JsonObject();
		try {
			if (c[0].equals("clear")) {
				ArchitectClientApi.get().clearComposite(c[1]);
			} else {
				JsonArray arr = JsonParser.parseString(new String(Base64.getDecoder().decode(c[2]), StandardCharsets.UTF_8)).getAsJsonArray();
				List<PreviewLayer> layers = new ArrayList<>();
				for (JsonElement e : arr) {
					JsonObject l = e.getAsJsonObject();
					JsonArray at = l.getAsJsonArray("origin");
					Set<BlockPos> only = null;
					if (l.has("onlyCells")) {
						only = new HashSet<>();
						for (JsonElement p : l.getAsJsonArray("onlyCells")) {
							JsonArray q = p.getAsJsonArray();
							only.add(new BlockPos(q.get(0).getAsInt(), q.get(1).getAsInt(), q.get(2).getAsInt()));
						}
					}
					layers.add(new PreviewLayer(l.get("blueprintId").getAsString(), new BlockPos(at.get(0).getAsInt(), at.get(1).getAsInt(), at.get(2)
						.getAsInt()), Rotation.values()[l.has("rotation") ? l.get("rotation").getAsInt() : 0], PreviewStyle.valueOf(l.get("style")
							.getAsString()), only));
				}
				ArchitectClientApi.get().previewComposite(c[1], layers);
			}
		} catch (RuntimeException e) {
			o.addProperty("error", e.toString());
		}
		JsonArray keys = new JsonArray();
		ArchitectClientApi.get().compositeKeys().stream().sorted().forEach(keys::add);
		o.add("keys", keys);
		o.addProperty("thread", Thread.currentThread().getName());
		ApiTest.RESULTS.put("composite:" + c[1], o);
	}
}
