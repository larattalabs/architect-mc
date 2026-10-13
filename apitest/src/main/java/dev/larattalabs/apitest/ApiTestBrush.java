package dev.larattalabs.apitest;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BrushKind;
import dev.larattalabs.architect.api.BrushRequest;
import dev.larattalabs.architect.api.BrushShape;
import dev.larattalabs.architect.api.Destruction;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.api.RemoveOptions;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;

/**
 * The slice 6c B steps of apitest (docs/CONTRACT.md "Phase 6c slice B"): a brush stroke through {@code dev.larattalabs.architect.api}
 * only.
 * <pre>
 * apib                                         the 1.21.0 surface: version, the brushes feature, the enums, PERMISSION appended, limits
 * brush &lt;key&gt; &lt;kind&gt; &lt;x&gt; &lt;y&gt; &lt;z&gt; &lt;r&gt; &lt;s&gt; [player_blocks]   Regions.brush (owner apitest:b, the player as actor) -> pending "brush:&lt;key&gt;"
 * brushundo &lt;key&gt; &lt;region&gt;                    Regions.remove (requester apitest:b) -> pending "brushundo:&lt;key&gt;"
 * </pre>
 */
public final class ApiTestBrush {
	static final String OWNER = "apitest:b";

	private ApiTestBrush() {
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		switch (a[0]) {
			case "apib": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				o.addProperty("brushes", api.features().contains("brushes"));
				o.addProperty("kinds", BrushKind.values().length);
				o.addProperty("shapes", BrushShape.values().length);
				o.addProperty("destruction", Destruction.values().length);
				o.addProperty("permissionAppended", Reason.PERMISSION.ordinal() == Reason.FORMAT.ordinal() + 1);
				o.addProperty("limits", Limits.BRUSH_RADIUS_MIN + "-" + Limits.BRUSH_RADIUS_MAX + "/" + Limits.BRUSH_STRENGTH_MIN + "-" + Limits.BRUSH_STRENGTH_MAX);
				return o;
			}
			case "brush": {
				BrushKind kind = BrushKind.valueOf(a[2].toUpperCase(java.util.Locale.ROOT));
				BlockPos at = new BlockPos(Integer.parseInt(a[3]), Integer.parseInt(a[4]), Integer.parseInt(a[5]));
				Destruction d = a.length > 8 && a[8].equals("player_blocks") ? Destruction.PLAYER_BLOCKS : Destruction.NATURAL_ONLY;
				var player = src.getPlayer();
				BrushRequest r = new BrushRequest(OWNER, Level.OVERWORLD, kind, BrushShape.SPHERE, at, Integer.parseInt(a[6]), Integer.parseInt(a[7]), null, null, d,
					player == null ? null : player.getUUID(), 1);
				return ApiTest.later("brush:" + a[1], api.regions().brush(r).handle((v, e) -> e == null ? view(v) : refused(e)));
			}
			case "brushundo": {
				return ApiTest.later("brushundo:" + a[1], api.regions().remove(a[2], new RemoveOptions(false, OWNER)).handle((v, e) -> {
					JsonObject o = new JsonObject();
					if (e != null) {
						return refused(e);
					}
					o.addProperty("removed", v.removed());
					o.addProperty("restored", v.restored());
					return o;
				}));
			}
			default:
				return new JsonPrimitive("unknown step " + a[0]);
		}
	}

	static JsonObject view(RegionView v) {
		JsonObject o = new JsonObject();
		o.addProperty("region", v.id());
		o.addProperty("state", v.state().name());
		o.addProperty("brush", v.brush());
		o.addProperty("owner", v.owner());
		o.addProperty("cellsWritten", v.cellsWritten());
		return o;
	}

	static JsonObject refused(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		JsonObject o = new JsonObject();
		o.addProperty("refused", c instanceof ArchitectRefused r ? r.reason().name() : "OTHER");
		o.addProperty("message", String.valueOf(c.getMessage()));
		return o;
	}
}
