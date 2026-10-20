package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.PaletteCheck;
import dev.larattalabs.architect.api.PlanArtifact;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.BiFunction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * (6c VOC-c) {@code rule.palette} in the mod (docs/CONTRACT.md "Phase 6c slice VOC-c" §4, Steward's S-VOCc-2 and S-VOCc-3): one measure
 * for the pre-check ({@link dev.larattalabs.architect.api.Regions#checkPalette}), the {@code realiseApproved} refusal ({@link Reason#PALETTE})
 * and the re-judge of a delta to another version of a lot's entry. The artifact carries what is measured (its {@code palette} rows: the
 * family's block ids, the unmeasured {@code natural} ids, the share, the lots in scope, the parts' counts), so the mod needs no
 * vocabulary: a lot's cells are its entry's template's non-air blocks (the first palette) less {@code natural}; the share is
 * {@code family / cells} (IEEE division, as the kit's), and no measured cell fits. The bound lots' block histograms also go to the kit
 * with a check ({@link #lotBlocks}), so the kit measures them the same way at check time.
 */
public final class PaletteRules {
	/** The realise's ext member: every palette rule's measure at the realise (a non-required rule never refuses; its row is recorded). */
	public static final String EXT_PALETTE = "architect_mc:palette";
	/** The plan's lots carry at most this many blocks per histogram sent (the sidecar's bound). */
	static final int MAX_BLOCKS = 4096;

	private PaletteRules() {
	}

	// ------------------------------------------------------------------ histograms

	/** A template's non-air blocks of its first palette by block id (sorted); empty for null. */
	public static Map<String, Long> histogram(@Nullable StructureTemplate t) {
		Map<String, Long> out = new TreeMap<>();
		if (t == null) {
			return out;
		}
		var pals = ((dev.larattalabs.architect.mixin.StructureTemplateAccessor) t).architect$palettes();
		if (pals.isEmpty()) {
			return out;
		}
		for (var b : pals.get(0).blocks()) {
			if (b.state().isAir()) {
				continue;
			}
			out.merge(BuiltInRegistries.BLOCK.getKey(b.state().getBlock()).toString(), 1L, Long::sum);
		}
		return out;
	}

	/** An entry id without its {@code @version}: the realise places the entry's current template (as {@code lotProblem} reads it). */
	static String bare(String entry) {
		return entry.contains("@") ? entry.substring(0, entry.indexOf('@')) : entry;
	}

	/** The histogram of the template a realise places for this entry (the current one), or null for an unknown entry. */
	static @Nullable Map<String, Long> placed(String entry) {
		StructureTemplate t = Blueprints.template(bare(entry));
		return t == null ? null : histogram(t);
	}

	/** Whether a plan holds a {@code rule.palette} part (only then does a check send {@link #lotBlocks}). */
	public static boolean hasPalette(JsonObject plan) {
		if (plan.get("rules") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject r && r.get("kind") instanceof JsonElement k && k.isJsonPrimitive() && "palette".equals(k.getAsString())) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * The check's {@code lotBlocks}: for a plan with a palette rule, each lot whose entry the plan names (a zone's program lots, its
	 * template's params lots, a district's lots) measured from that entry's current template: {@code {lot: {block: n}}}. Unknown entries
	 * are left out (the kit then holds the lot pending). Empty for a plan without a palette rule.
	 */
	public static JsonObject lotBlocks(JsonObject plan) {
		JsonObject out = new JsonObject();
		if (!hasPalette(plan)) {
			return out;
		}
		Map<String, String> named = new TreeMap<>();
		if (plan.get("zones") instanceof JsonArray zones) {
			for (JsonElement z : zones) {
				if (!(z instanceof JsonObject zo) || !(zo.get("program") instanceof JsonObject p)) {
					continue;
				}
				lotsOf(p.get("lots"), named);
				if (p.get("params") instanceof JsonObject pp) {
					lotsOf(pp.get("lots"), named);
				}
				if (p.get("districts") instanceof JsonArray ds) {
					for (JsonElement d : ds) {
						if (d instanceof JsonObject dob) {
							lotsOf(dob.get("lots"), named);
						}
					}
				}
			}
		}
		for (var e : named.entrySet()) {
			Map<String, Long> h = placed(e.getValue());
			if (h == null || h.isEmpty() || h.size() > MAX_BLOCKS) {
				continue;
			}
			JsonObject o = new JsonObject();
			h.forEach(o::addProperty);
			out.add(e.getKey(), o);
		}
		return out;
	}

	private static void lotsOf(@Nullable JsonElement lots, Map<String, String> into) {
		if (lots instanceof JsonArray a) {
			for (JsonElement l : a) {
				if (l instanceof JsonObject lo && lo.get("id") instanceof JsonElement id && id.isJsonPrimitive() && lo.get("entry") instanceof JsonElement en
					&& en.isJsonPrimitive()) {
					into.put(id.getAsString(), en.getAsString());
				}
			}
		}
	}

	// ------------------------------------------------------------------ the measure

	/**
	 * The palette rules of an artifact's body measured with {@code entries} (lot -> entry bound now). {@code histOf(lot, entry)}: the
	 * block histogram of the template that lot gets (null: unknown, measured as nothing). Rules in id order; lots in id order.
	 */
	public static PaletteCheck measure(JsonObject body, Map<String, String> entries, BiFunction<String, String, @Nullable Map<String, Long>> histOf) {
		List<PaletteCheck.Rule> rules = new ArrayList<>();
		if (!(body.get("palette") instanceof JsonArray rows)) {
			return new PaletteCheck(true, rules);
		}
		boolean ok = true;
		Map<String, JsonObject> byRule = new TreeMap<>();
		for (JsonElement e : rows) {
			if (e instanceof JsonObject r && r.get("rule") instanceof JsonElement id && id.isJsonPrimitive()) {
				byRule.put(id.getAsString(), r);
			}
		}
		for (var en : byRule.entrySet()) {
			JsonObject r = en.getValue();
			Set<String> fam = strings(r.get("blocks"));
			Set<String> natural = strings(r.get("natural"));
			JsonArray share = r.getAsJsonArray("share");
			double min = share.get(0).getAsDouble(), max = share.get(1).getAsDouble();
			long cells = r.get("partsCells").getAsLong(), family = r.get("partsFamily").getAsLong();
			List<PaletteCheck.Lot> lots = new ArrayList<>();
			List<String> pending = new ArrayList<>();
			for (String lot : new java.util.TreeSet<>(strings(r.get("lots")))) {
				String entry = entries.get(lot);
				if (entry == null) {
					pending.add(lot);
					continue;
				}
				Map<String, Long> h = histOf.apply(lot, entry);
				long c = 0, f = 0;
				if (h != null) {
					for (var b : h.entrySet()) {
						if (b.getValue() <= 0 || natural.contains(b.getKey())) {
							continue;
						}
						c += b.getValue();
						if (fam.contains(b.getKey())) {
							f += b.getValue();
						}
					}
				}
				lots.add(new PaletteCheck.Lot(lot, entry, c, f));
				cells += c;
				family += f;
			}
			Double s = cells == 0 ? null : family / (double) cells;
			boolean fits = s == null || (s >= min && s <= max);
			String worst = null;
			long worstBad = 0;
			for (PaletteCheck.Lot l : lots) {
				long bad = min > 0 ? l.cells() - l.familyCells() : l.familyCells();
				if (bad > worstBad) {
					worstBad = bad;
					worst = l.lot();
				}
			}
			boolean required = r.get("required") instanceof JsonElement q && q.isJsonPrimitive() && q.getAsBoolean();
			if (required && !fits) {
				ok = false;
			}
			rules.add(new PaletteCheck.Rule(en.getKey(), required, r.get("family").getAsString(), min, max, cells, family, s, fits, worst, lots, pending));
		}
		return new PaletteCheck(ok, rules);
	}

	private static Set<String> strings(@Nullable JsonElement e) {
		Set<String> out = new HashSet<>();
		if (e instanceof JsonArray a) {
			a.forEach(x -> out.add(x.getAsString()));
		}
		return out;
	}

	/** The lots an artifact binds (its {@code lots[].entry}), then {@code given} over them. */
	static Map<String, String> bound(JsonObject body, Map<String, String> given) {
		Map<String, String> lots = new LinkedHashMap<>();
		if (body.get("lots") instanceof JsonArray la) {
			for (JsonElement e : la) {
				JsonObject l = e.getAsJsonObject();
				if (l.get("entry") instanceof JsonElement en && en.isJsonPrimitive()) {
					lots.put(l.get("id").getAsString(), en.getAsString());
				}
			}
		}
		lots.putAll(given);
		return lots;
	}

	/** {@link dev.larattalabs.architect.api.Regions#checkPalette}. */
	static Optional<PaletteCheck> check(String sha, Map<String, String> lotEntries) {
		Optional<PlanArtifact> a = sha == null ? Optional.empty() : PlanChecks.artifact(sha);
		if (a.isEmpty() || a.get().removed() || a.get().body() == null) {
			return Optional.empty();
		}
		JsonObject body = a.get().body();
		return Optional.of(measure(body, bound(body, lotEntries == null ? Map.of() : lotEntries), (lot, entry) -> placed(entry)));
	}

	/**
	 * The refusal for the first required rule that does not fit (rules in id order), as {@code {message, rule}}, or null. The message
	 * carries the evidence (§4): the rule, the worst lot and its entry, the family, the share, the measured share and the cells.
	 */
	static String @Nullable [] refusal(PaletteCheck c) {
		for (PaletteCheck.Rule r : c.rules()) {
			if (!r.required() || r.fits()) {
				continue;
			}
			PaletteCheck.Lot w = r.lots().stream().filter(l -> l.lot().equals(r.worstLot())).findFirst().orElse(null);
			JsonObject ev = new JsonObject();
			ev.addProperty("rule", r.rule());
			ev.addProperty("lot", r.worstLot());
			ev.addProperty("entry", w == null ? null : w.entry());
			ev.addProperty("family", r.family());
			JsonArray sh = new JsonArray();
			sh.add(r.shareMin());
			sh.add(r.shareMax());
			ev.add("share", sh);
			ev.addProperty("measured", r.share());
			ev.addProperty("cells", r.cells());
			ev.addProperty("familyCells", r.familyCells());
			String msg = "rule " + r.rule() + " (" + r.family() + ", share [" + r.shareMin() + ", " + r.shareMax() + "]) measures " + r.share() + " over "
				+ r.cells() + " cells with the lots bound now" + (w == null ? "" : "; the worst lot is " + w.lot() + " (entry " + w.entry() + ": " + w.familyCells() + " of "
					+ w.cells() + " cells " + r.family() + ")") + ": bind another entry or drop required " + ev;
			return new String[] {msg, r.rule()};
		}
		return null;
	}

	/** The realise's {@link #EXT_PALETTE} rows: every rule measured (required or not). */
	static JsonArray extRows(PaletteCheck c) {
		JsonArray out = new JsonArray();
		for (PaletteCheck.Rule r : c.rules()) {
			JsonObject o = new JsonObject();
			o.addProperty("rule", r.rule());
			o.addProperty("required", r.required());
			o.addProperty("family", r.family());
			JsonArray sh = new JsonArray();
			sh.add(r.shareMin());
			sh.add(r.shareMax());
			o.add("share", sh);
			o.addProperty("measured", r.share());
			o.addProperty("cells", r.cells());
			o.addProperty("familyCells", r.familyCells());
			o.addProperty("fits", r.fits());
			JsonObject lots = new JsonObject();
			for (PaletteCheck.Lot l : r.lots()) {
				JsonArray a = new JsonArray();
				a.add(l.familyCells());
				a.add(l.cells());
				a.add(l.entry());
				lots.add(l.lot(), a);
			}
			o.add("lots", lots);
			JsonArray p = new JsonArray();
			r.pendingLots().forEach(p::add);
			o.add("pendingLots", p);
			out.add(o);
		}
		return out;
	}

	// ------------------------------------------------------------------ a lot replaced later (S-VOCc-3)

	/** A delta's palette judgement: a refusal for a required rule the new version breaks, else notes (non-required rules), or nothing. */
	public record DeltaJudge(@Nullable String refusal, @Nullable String rule, List<String> notes) {
	}

	/**
	 * (S-VOCc-3) A site moving to version {@code toVersion} of its entry, when the site is a lot of a standing region realised from an
	 * artifact with palette rows: each rule over that lot measured again with the lot's new template and every other lot's standing
	 * version. Null when the site is not such a lot (or the artifact is gone). Server thread.
	 */
	public static @Nullable DeltaJudge delta(MinecraftServer server, String siteId, int toVersion) {
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			RegionRec rec = l.rec();
			if (rec.state == RegionState.REMOVED) {
				continue;
			}
			String lotId = null;
			for (var e : rec.lots.entrySet()) {
				if (siteId.equals(e.getValue().siteId)) {
					lotId = e.getKey();
				}
			}
			if (lotId == null) {
				continue;
			}
			String sha = PlanChecks.artifactOf(rec);
			Optional<PlanArtifact> a = sha == null ? Optional.empty() : PlanChecks.artifact(sha);
			if (a.isEmpty() || a.get().removed() || a.get().body() == null || !(a.get().body().get("palette") instanceof JsonArray)) {
				return null;
			}
			Map<String, String> entries = new LinkedHashMap<>();
			Map<String, String> sites = new LinkedHashMap<>();
			rec.lots.forEach((id, ls) -> {
				if (ls.entry != null && ls.siteId != null && Sites.get(ls.siteId) != null) {
					entries.put(id, ls.entry);
					sites.put(id, ls.siteId);
				}
			});
			final String target = lotId;
			PaletteCheck c = measure(a.get().body(), entries, (lot, entry) -> {
				Site st = Sites.get(sites.get(lot));
				if (st == null) {
					return placed(entry);
				}
				int v = lot.equals(target) ? toVersion : st.versioning().version();
				Blueprints.Version bv = v > 0 ? Blueprints.version(server, st.blueprint(), v) : null;
				return bv != null ? histogram(bv.entry().template()) : placed(entry);
			});
			List<String> notes = new ArrayList<>();
			String refusal = null, rule = null;
			for (PaletteCheck.Rule r : c.rules()) {
				if (r.lots().stream().noneMatch(x -> x.lot().equals(target))) {
					continue;
				}
				String m = "palette rule " + r.rule() + " (" + r.family() + ", share [" + r.shareMin() + ", " + r.shareMax() + "]) of region " + rec.id + " measures "
					+ r.share() + " over " + r.cells() + " cells with lot " + target + " at version " + toVersion;
				if (r.fits()) {
					notes.add(m + ": fits");
				} else if (r.required()) {
					if (refusal == null) {
						refusal = m + ": outside its share (a required rule; keep the lot's version or drop required)";
						rule = r.rule();
					}
				} else {
					notes.add(m + ": outside its share (the rule is not required)");
				}
			}
			return new DeltaJudge(refusal, rule, notes);
		}
		return null;
	}
}
