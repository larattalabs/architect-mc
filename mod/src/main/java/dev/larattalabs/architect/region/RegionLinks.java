package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.placement.Blueprints;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * (7b slice LP) The link pass at realise (docs/CONTRACT.md "Phase 7b" row 10, changes 3 and 4, "Slice LP as built"). A plan whose IR
 * records port links ({@code portLinks}: connectors between site lots' ports, routed at plan time to the sites' ports) is realised
 * from IR v2: the helper replays the plan with the bound entries' own ports ({@code region.link}), writes the links in the stage
 * {@code site_links} after the lots, and proves every other member of the IR unchanged. A link that can't reach an entry's port
 * refuses the whole realise {@link Reason#NO_LINK} (detail {@code {lot, port}}) before anything is reserved or written; a replay that
 * isn't the checked plan refuses {@link Reason#ARTIFACT_STALE}. A plan without port links (every plan before 7b, every revision) never
 * comes here: its realise is byte for byte as before (change 4). Internal.
 */
final class RegionLinks {
	private RegionLinks() {
	}

	/** The realise report's member ({@code RegionView.ext}): the links written, one row each ({@code $.links[]}). */
	static final String EXT_LINKS = "architect_mc:links";

	/** IR v2 and its report rows; {@code plan} is the plan record with the linked IR in place of the checked one (same plan id). */
	record Linked(RegionsImpl.PlanRec plan, JsonArray rows) {
	}

	/** Does the IR record port links (so its realise runs the link pass)? */
	static boolean needs(@Nullable JsonObject ir) {
		return ir != null && ir.get("portLinks") instanceof JsonArray a && !a.isEmpty() && !ir.has("linked");
	}

	/** The site lots the IR's port links end on, sorted. */
	static TreeSet<String> lots(JsonObject ir) {
		TreeSet<String> out = new TreeSet<>();
		for (JsonElement e : ir.getAsJsonArray("portLinks")) {
			if (e instanceof JsonObject l) {
				for (String k : new String[] {"from", "to"}) {
					if (l.get(k) instanceof JsonObject end && end.get("lot") instanceof JsonElement lot && lot.isJsonPrimitive()) {
						out.add(lot.getAsString());
					}
				}
			}
		}
		return out;
	}

	/**
	 * The helper's input ({@code {lots: {lot: {entry, ports}}}}): each linked lot's bound entry and its own ports (the template sidecar's
	 * {@code ports}, design cells). A lot with no entry bound, or one the library doesn't hold, is left out: the kit then answers NO_LINK
	 * naming it.
	 */
	static JsonObject input(JsonObject ir, Map<String, String> lotEntries) {
		JsonObject lots = new JsonObject();
		for (String lot : lots(ir)) {
			String entry = lotEntries.get(lot);
			if (entry == null) {
				continue;
			}
			String id = entry.contains("@") ? entry.substring(0, entry.indexOf('@')) : entry;
			Blueprints.Entry ent = Blueprints.entry(id);
			if (ent == null) {
				continue;
			}
			JsonObject one = new JsonObject();
			one.addProperty("entry", entry);
			JsonArray ports = new JsonArray();
			if (ent.json() != null && ent.json().get("ports") instanceof JsonArray pa) {
				for (JsonElement p : pa) {
					if (p instanceof JsonObject po && po.get("name") instanceof JsonElement n && n.isJsonPrimitive() && po.get("kind") instanceof JsonElement k && k
						.isJsonPrimitive() && po.get("facing") instanceof JsonElement f && f.isJsonPrimitive()) {
						ports.add(po.deepCopy());
					}
				}
			}
			one.add("ports", ports);
			lots.add(lot, one);
		}
		JsonObject o = new JsonObject();
		o.add("lots", lots);
		return o;
	}

	/** Run the link pass for a realise of {@code p} with {@code lotEntries}. Server thread to start. */
	static CompletableFuture<Linked> run(MinecraftServer s, RegionsImpl.PlanRec p, Map<String, String> lotEntries) {
		TileStream.Link link = TileStream.link;
		if (link == null || !link.connected()) {
			return CompletableFuture.failedFuture(RegionsImpl.refusal(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected: a plan with links to site lots' ports is realised through its link pass"));
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.link");
		m.addProperty("planId", p.planId());
		m.addProperty("irSha", p.irSha());
		m.add("links", input(p.ir().json(), lotEntries));
		return link.send(m).thenCompose(ack -> RegionsImpl.onServer(s, () -> {
			if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
				String err = RegionsImpl.str(ack, "error");
				// the replay is not the checked plan, or the helper lost the plan: check the plan again
				Reason why = err != null && (err.contains("REPLAY") || err.contains("no recorded arguments") || err.contains("no plan") || err.contains("IR is not")) ? Reason.ARTIFACT_STALE
					: Reason.OTHER;
				throw RegionsImpl.refusal(why, "the link pass failed: " + err + (why == Reason.ARTIFACT_STALE ? " (check the plan again)" : ""));
			}
			JsonObject res = ack.get("result") instanceof JsonObject r ? r : ack;
			if (res.get("noLink") instanceof JsonObject nl) {
				String lot = RegionsImpl.str(nl, "lot", "?"), port = nl.get("port") instanceof JsonElement pe && pe.isJsonPrimitive() ? pe.getAsString() : null;
				JsonObject detail = new JsonObject();
				detail.addProperty("lot", lot);
				if (port != null) {
					detail.addProperty("port", port);
				} else {
					detail.add("port", com.google.gson.JsonNull.INSTANCE);
				}
				throw new RegionsImpl.RegionException(Reason.NO_LINK, "lot " + lot + (port == null ? "" : " port " + port) + ": " + RegionsImpl.str(nl, "message", "no link"),
					detail.toString());
			}
			String text = RegionsImpl.str(res, "ir");
			String sha = RegionsImpl.str(res, "irSha");
			if (text == null || sha == null || !sha.equals(sha256(text))) {
				throw RegionsImpl.refusal(Reason.OTHER, "the link pass answered no IR, or one that doesn't hash to its irSha");
			}
			JsonObject irJson = JsonParser.parseString(text).getAsJsonObject();
			Ir ir = Ir.of(irJson);
			RegionsImpl.PlanRec q = new RegionsImpl.PlanRec(p.planId(), p.programId(), p.programSha(), sha, p.surveySha(), p.seed(), p.dimension(), p.claim(), p
				.owner(), p.ext(), p.planned(), ir, p.chunks(), p.chunksToGenerate(), p.opKey(), p.opHash());
			JsonArray rows = res.get("links") instanceof JsonArray a ? a.deepCopy() : new JsonArray();
			return new Linked(q, rows);
		}));
	}

	static String sha256(String text) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}
}
