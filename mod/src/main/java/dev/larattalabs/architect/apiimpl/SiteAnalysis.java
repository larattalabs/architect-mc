package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Affordance;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionRefused;
import dev.larattalabs.architect.api.SiteFrame;
import dev.larattalabs.architect.api.SiteSample;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.api.Volume;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7b AF) {@link dev.larattalabs.architect.api.Survey#site}: the lot box grown by {@link #MARGIN} on every side (clamped to the world's
 * height), sampled and frozen by {@link VolumeSurvey} (read only: it writes no block, only the frozen file
 * {@code <world>/architect/volumes/<sha>.bin}), uploaded to the helper, analysed there by the kit ({@code site.analyse}: the same
 * analysis as a region plan's {@code affordances[]}, so the ids agree), and answered on the server thread. Also the wire reader of
 * {@link Affordance} (the kit's {@code {id, kind, box, anchors, normal, metrics, score}}). Internal.
 */
public final class SiteAnalysis {
	/** The margin round the lot (kit/lib/siteFits.mjs SITE_MARGIN). */
	public static final int MARGIN = 8;
	/** The largest lot (a design's 96x64x96 cap): a site volume of at most 112x80x112 cells. */
	public static final int MAX_X = 96, MAX_Y = 64, MAX_Z = 96;

	private SiteAnalysis() {
	}

	/** The sampled box: the lot plus the margin, its y clamped to the level's build height. */
	public static BoundingBox volumeBox(ServerLevel level, BoundingBox lot) {
		return new BoundingBox(lot.minX() - MARGIN, Math.max(level.getMinY(), lot.minY() - MARGIN), lot.minZ() - MARGIN, lot.maxX() + MARGIN, Math.min(
			level.getMaxY(), lot.maxY() + MARGIN), lot.maxZ() + MARGIN);
	}

	public static CompletableFuture<SiteSample> site(ServerLevel level, BoundingBox lot, FitMode fit, @Nullable LoadPolicy load) {
		if (level == null || lot == null || fit == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("Survey.site needs a level, a lot box and a fit"));
		}
		if (lot.getXSpan() > MAX_X || lot.getYSpan() > MAX_Y || lot.getZSpan() > MAX_Z) {
			return CompletableFuture.failedFuture(new RegionRefused(Reason.REGION_LIMIT, "the lot is " + lot.getXSpan() + "x" + lot.getYSpan() + "x" + lot
				.getZSpan() + " (at most " + MAX_X + "x" + MAX_Y + "x" + MAX_Z + ")"));
		}
		if (lot.minY() < level.getMinY() || lot.maxY() > level.getMaxY()) {
			return CompletableFuture.failedFuture(new RegionRefused(Reason.REGION_LIMIT, "the lot is outside the world's height (" + level.getMinY() + ".."
				+ level.getMaxY() + ")"));
		}
		if (!RegionBridge.INSTANCE.connected()) {
			return CompletableFuture.failedFuture(new RegionRefused(Reason.SIDECAR_UNAVAILABLE, "the site analysis needs the helper (sidecar)"));
		}
		MinecraftServer s = level.getServer();
		BoundingBox vb = volumeBox(level, lot);
		CompletableFuture<SiteSample> chain = VolumeSurvey.start(level, vb, load == null ? LoadPolicy.LOADED_ONLY : load, null).thenCompose(SurveyImpl::upload)
			.thenCompose(v -> {
			if (v.blobId().startsWith("local:")) {
				throw new RegionRefused(Reason.SIDECAR_UNAVAILABLE, "the volume could not be sent to the helper (sidecar)");
			}
			return RegionBridge.INSTANCE.send(message(v, lot, fit)).thenApply(ack -> sample(v, ack));
		});
		// the answer, or the failure, on the server thread
		CompletableFuture<SiteSample> out = new CompletableFuture<>();
		chain.whenComplete((x, e) -> {
			Runnable r = () -> {
				if (e != null) {
					out.completeExceptionally(e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e);
				} else {
					out.complete(x);
				}
			};
			if (s.isSameThread()) {
				r.run();
			} else {
				s.execute(r);
			}
		});
		return out;
	}

	/** The {@code site.analyse} message. */
	public static JsonObject message(Volume v, BoundingBox lot, FitMode fit) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "site.analyse");
		m.addProperty("volumeBlobId", v.blobId());
		m.addProperty("sha", v.sha());
		m.add("lot", SiteSpec.box(lot));
		m.addProperty("fit", fit.wire());
		return m;
	}

	/** The helper's answer as a {@link SiteSample}; a refusal or an answer about another volume fails. */
	public static SiteSample sample(Volume v, JsonObject ack) {
		if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
			String e = ack.has("error") && ack.get("error").isJsonPrimitive() ? ack.get("error").getAsString() : "refused";
			throw new RegionRefused(Reason.OTHER, "the helper's site analysis failed: " + e);
		}
		JsonObject r = ack.has("result") && ack.get("result").isJsonObject() ? ack.getAsJsonObject("result") : ack;
		if (!r.has("sha") || !v.sha().equals(r.get("sha").getAsString())) {
			throw new RegionRefused(Reason.OTHER, "the helper analysed another volume");
		}
		List<Affordance> list = affordances(r.get("affordances"));
		Optional<SiteFrame> proposed = Optional.empty();
		if (r.get("proposed") instanceof JsonObject p && p.get("frame") instanceof JsonObject f) {
			proposed = Optional.of(SiteFrame.fromWire(f));
		}
		return new SiteSample(v, list, proposed);
	}

	/** A wire list of affordances ({@code null} or absent: none); an unreadable one throws {@link IllegalArgumentException}. */
	public static List<Affordance> affordances(@Nullable JsonElement e) {
		List<Affordance> out = new ArrayList<>();
		if (e == null || e.isJsonNull()) {
			return out;
		}
		if (!e.isJsonArray()) {
			throw new IllegalArgumentException("affordances: an array expected");
		}
		for (JsonElement x : e.getAsJsonArray()) {
			out.add(affordance(x.getAsJsonObject()));
		}
		return out;
	}

	/** An affordance in the kit's wire shape (the inverse of {@link #affordance}). */
	public static JsonObject wire(Affordance a) {
		JsonObject o = new JsonObject();
		o.addProperty("id", a.id());
		o.addProperty("kind", a.kind().wire());
		o.add("box", SiteSpec.box(a.box()));
		JsonArray an = new JsonArray();
		for (BlockPos p : a.anchors()) {
			JsonArray q = new JsonArray();
			q.add(p.getX());
			q.add(p.getY());
			q.add(p.getZ());
			an.add(q);
		}
		o.add("anchors", an);
		if (a.normal() == null) {
			o.add("normal", com.google.gson.JsonNull.INSTANCE);
		} else {
			o.addProperty("normal", a.normal().getName());
		}
		o.add("metrics", a.metrics().deepCopy());
		o.addProperty("score", a.score());
		return o;
	}

	/** One affordance from the kit's wire shape. */
	public static Affordance affordance(JsonObject o) {
		String id = o.get("id").getAsString();
		Affordance.Kind kind = Affordance.Kind.valueOf(o.get("kind").getAsString().toUpperCase(Locale.ROOT));
		BoundingBox box = SiteSpec.boxOf(o.getAsJsonObject("box"));
		List<BlockPos> anchors = new ArrayList<>();
		if (o.get("anchors") instanceof JsonArray a) {
			for (JsonElement p : a) {
				JsonArray q = p.getAsJsonArray();
				anchors.add(new BlockPos(q.get(0).getAsInt(), q.get(1).getAsInt(), q.get(2).getAsInt()));
			}
		}
		Direction normal = null;
		if (o.has("normal") && !o.get("normal").isJsonNull()) {
			normal = Direction.byName(o.get("normal").getAsString());
			if (normal == null) {
				throw new IllegalArgumentException("affordance " + id + ": normal " + o.get("normal"));
			}
		}
		JsonObject metrics = o.get("metrics") instanceof JsonObject m ? m.deepCopy() : new JsonObject();
		return new Affordance(id, kind, box, anchors, normal, metrics, o.has("score") ? o.get("score").getAsDouble() : 0);
	}
}
