package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.Cost;
import dev.larattalabs.architect.api.Critique;
import dev.larattalabs.architect.api.CritiqueMode;
import dev.larattalabs.architect.api.CritiqueSpec;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.JobSpec;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.jspecify.annotations.Nullable;

/**
 * Phase 5a wire forms and views (docs/CONTRACT.md "Phase 5a contract"; sidecar/src/protocol.ts is the source of the shapes): a
 * {@link CritiqueSpec} as sent, a {@link Critique} from its three shapes (a design's {@code CritiqueRecord}, the summary of a
 * group item or of an entry's blueprint JSON, an entry's {@code critique.json} with its staleness), the rounds that fire
 * DESIGN_CRITIQUED, the estimate's critique figures, job images, a bible's restraint and archive flag. Pure (files aside),
 * tested without a game. Internal.
 */
public final class Wire5a {
	/** The sidecar's 5a feature names -> the Java API's stable ones. */
	public static final Map<String, String> FEATURE_NAMES = Map.of("critique", "critique", "critique.report", "critiqueReport", "job.images",
		"jobImages", "bible.admin", "bibleAdmin", "bible.restraint", "bibleRestraint");
	/** The file next to an entry that holds its latest verdict. */
	public static final String CRITIQUE_FILE = "critique.json";

	private Wire5a() {
	}

	// ------------------------------------------------------------------ API -> sidecar

	/** A {@link CritiqueSpec} as sent ({@code CritiqueSpec}): the mode, and the fields set. */
	public static JsonObject spec(CritiqueSpec s) {
		JsonObject o = new JsonObject();
		o.addProperty("mode", s.mode().wire());
		if (s.maxRevisions() != null) {
			o.addProperty("maxRevisions", s.maxRevisions());
		}
		if (s.model() != null) {
			o.addProperty("model", s.model());
		}
		if (s.effort() != null) {
			o.addProperty("effort", s.effort());
		}
		if (s.budgetUsd() != null) {
			o.addProperty("budgetUsd", s.budgetUsd());
		}
		if (s.maxMinutes() != null) {
			o.addProperty("maxMinutes", s.maxMinutes());
		}
		if (s.shipScore() != null) {
			o.addProperty("shipScore", s.shipScore());
		}
		if (!s.views().isEmpty()) {
			JsonArray a = new JsonArray();
			s.views().forEach(a::add);
			o.add("views", a);
		}
		if (s.neighbours() != null) {
			o.addProperty("neighbours", s.neighbours());
		}
		if (!s.extraCriteria().isEmpty()) {
			JsonArray a = new JsonArray();
			s.extraCriteria().forEach(a::add);
			o.add("extraCriteria", a);
		}
		return o;
	}

	/** A spec back from JSON (a request kept by the helper); null when absent or not an object. Never throws: invalid -> null. */
	public static @Nullable CritiqueSpec spec(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return null;
		}
		JsonObject o = e.getAsJsonObject();
		try {
			Double mr = Wire4b.dbl(o, "maxRevisions");
			return new CritiqueSpec(CritiqueMode.of(Wire4b.str(o, "mode")), mr == null ? null : mr.intValue(), Wire4b.str(o, "model"), Wire4b.str(o,
				"effort"), Wire4b.dbl(o, "budgetUsd"), Wire4b.dbl(o, "maxMinutes"), Wire4b.dbl(o, "shipScore"), Wire4b.strings(o, "views"),
				o.has("neighbours") && o.get("neighbours").isJsonPrimitive() ? o.get("neighbours").getAsBoolean() : null, Wire4b.strings(o,
					"extraCriteria"));
		} catch (IllegalArgumentException ex) {
			return null;
		}
	}

	/** A job's images ({@code [{blob, label}]}). */
	public static JsonArray images(List<JobSpec.ImageRef> refs) {
		JsonArray a = new JsonArray();
		for (JobSpec.ImageRef r : refs) {
			JsonObject o = new JsonObject();
			o.addProperty("blob", r.blob());
			o.addProperty("label", r.label());
			a.add(o);
		}
		return a;
	}

	/** {@code design.critique {entryId, spec}}; the spec must be a report (null = report with the defaults). */
	public static JsonObject critiqueMessage(String entryId, @Nullable CritiqueSpec spec) {
		if (entryId == null || !entryId.matches("[a-z0-9_]{1,64}")) {
			throw new IllegalArgumentException("not a library id: " + entryId);
		}
		if (spec != null && spec.mode() != CritiqueMode.REPORT) {
			throw new IllegalArgumentException("a critique of a library entry is a report (mode REPORT); a loop on an installed entry is not in 1.6.0");
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "design.critique");
		m.addProperty("entryId", entryId);
		m.add("spec", spec(spec == null ? CritiqueSpec.report() : spec));
		return m;
	}

	// ------------------------------------------------------------------ sidecar -> API: critique

	private static double num(@Nullable JsonElement e) {
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsDouble() : Double.NaN;
	}

	private static Map<String, Integer> scores(JsonObject o) {
		Map<String, Integer> out = new LinkedHashMap<>();
		for (var e : Wire4b.obj(o, "scores").entrySet()) {
			double v = num(e.getValue());
			if (!Double.isNaN(v)) {
				out.put(e.getKey(), (int) Math.round(v));
			}
		}
		return out;
	}

	/** {@code CritiqueIssue[]} under {@code k}. */
	public static List<Critique.Issue> issues(JsonObject o, String k) {
		List<Critique.Issue> out = new ArrayList<>();
		JsonElement a = o.get(k);
		if (a != null && a.isJsonArray()) {
			for (JsonElement e : a.getAsJsonArray()) {
				if (e.isJsonObject()) {
					JsonObject i = e.getAsJsonObject();
					out.add(new Critique.Issue(Critique.Priority.of(Wire4b.str(i, "priority")), Wire4b.str(i, "part"), Wire4b.str(i, "view", ""),
						Wire4b.str(i, "what", ""), Wire4b.str(i, "fix", "")));
				}
			}
		}
		return out;
	}

	private static List<Integer> ints(JsonObject o, String k) {
		List<Integer> out = new ArrayList<>();
		JsonElement a = o.get(k);
		if (a != null && a.isJsonArray()) {
			for (JsonElement e : a.getAsJsonArray()) {
				if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber()) {
					out.add(e.getAsInt());
				}
			}
		}
		return out;
	}

	/** One {@code CritiqueRound} of a design record. */
	public static Critique.Round round(JsonObject r) {
		List<Critique.Issue> is = issues(r, "issues");
		Double cost = Wire4b.dbl(r, "cost");
		return new Critique.Round((int) Wire4b.num(r, "n"), Wire4b.str(r, "verdict"), num(r.get("overall")), scores(r), is, ints(r, "resolved"),
			bool(r, "ship"), cost == null ? 0 : cost, Wire4b.num(r, "ms"), bool(r, "kept"), is.size(), Optional.ofNullable(Wire4b.str(r, "summary")),
			Optional.ofNullable(Wire4b.str(r, "error")), Wire4b.strings(r, "notes"));
	}

	private static boolean bool(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean() && e.getAsBoolean();
	}

	/**
	 * The best round as the sidecar picks it ({@code bestRound}): a kept round with the highest overall (ties: the later one); an
	 * unscored kept round only when no kept round is scored. Null: none kept.
	 */
	public static Critique.@Nullable Round bestRound(List<Critique.Round> rounds) {
		Critique.Round best = null;
		for (Critique.Round r : rounds) {
			if (!r.kept()) {
				continue;
			}
			if (!r.scored()) {
				if (best == null || !best.scored()) {
					best = r;
				}
				continue;
			}
			if (best == null || !best.scored() || r.overall() >= best.overall()) {
				best = r;
			}
		}
		return best;
	}

	/**
	 * A design's {@code critique} ({@code CritiqueRecord}: every round in full). While the loop runs ({@code best} absent) the best
	 * round so far stands in for it; {@code end} is null until the loop ends. Empty when absent.
	 */
	public static Optional<Critique> record(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return Optional.empty();
		}
		JsonObject c = e.getAsJsonObject();
		List<Critique.Round> rounds = new ArrayList<>();
		JsonElement rs = c.get("rounds");
		if (rs != null && rs.isJsonArray()) {
			for (JsonElement r : rs.getAsJsonArray()) {
				if (r.isJsonObject()) {
					rounds.add(round(r.getAsJsonObject()));
				}
			}
		}
		Critique.Round best = null;
		if (c.has("best") && !c.get("best").isJsonNull()) {
			int b = (int) Wire4b.num(c, "best");
			best = rounds.stream().filter(r -> r.n() == b).findFirst().orElse(null);
		}
		if (best == null) {
			best = bestRound(rounds);
		}
		double overall = c.has("overall") ? num(c.get("overall")) : Double.NaN;
		if (Double.isNaN(overall) && best != null) {
			overall = best.overall();
		}
		JsonObject cost = Wire4b.obj(c, "cost");
		return Optional.of(new Critique(rounds, c.has("best") && !c.get("best").isJsonNull() ? (int) Wire4b.num(c, "best") : best == null ? -1 : best.n(),
			Critique.EndReason.of(Wire4b.str(c, "end")), overall, best == null ? Map.of() : best.scores(), best == null ? List.of() : best.issues(),
			cost.has("critic") && cost.get("critic").isJsonObject() ? Cost.fromJson(cost.getAsJsonObject("critic")) : Cost.NONE, cost.has("revise")
				&& cost.get("revise").isJsonObject() ? Cost.fromJson(cost.getAsJsonObject("revise")) : Cost.NONE, CritiqueMode.of(Wire4b.str(c, "mode",
					"loop")), Optional.ofNullable(Wire4b.str(c, "pending")), false));
	}

	/**
	 * A critique summary: a group item's ({@code {rounds: <count>, best?, end?, overall?}}) or an entry's blueprint JSON
	 * {@code critique} ({@code {mode, end, best, rounds: <count>, overall, scores, openIssues}}). Rounds come as a count: the
	 * {@link Critique#rounds()} list is empty.
	 */
	public static Optional<Critique> summary(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return Optional.empty();
		}
		JsonObject c = e.getAsJsonObject();
		return Optional.of(new Critique(List.of(), c.has("best") && !c.get("best").isJsonNull() ? (int) Wire4b.num(c, "best") : -1,
			Critique.EndReason.of(Wire4b.str(c, "end")), num(c.get("overall")), scores(c), issues(c, "openIssues"), Cost.NONE, Cost.NONE,
			CritiqueMode.of(Wire4b.str(c, "mode", "loop")), Optional.empty(), false));
	}

	/** How many rounds a summary counts ({@code rounds} as a number), or -1. */
	public static int summaryRounds(@Nullable JsonElement e) {
		return e != null && e.isJsonObject() && e.getAsJsonObject().has("rounds") && e.getAsJsonObject().get("rounds").isJsonPrimitive()
			? e.getAsJsonObject().get("rounds").getAsInt() : -1;
	}

	/**
	 * An entry's {@code critique.json} (sidecar critique.ts {@code writeEntryCritique}). {@code currentRevision}: the sha256 (hex)
	 * of the entry's {@code .nbt} now, or null when it has none; the verdict is stale unless its {@code entryRevision} equals it.
	 */
	public static Critique critiqueFile(JsonObject j, @Nullable String currentRevision) {
		JsonObject v = j.has("verdict") && j.get("verdict").isJsonObject() ? j.getAsJsonObject("verdict") : null;
		int best = j.has("best") && !j.get("best").isJsonNull() ? (int) Wire4b.num(j, "best") : -1;
		List<Critique.Round> rounds = new ArrayList<>();
		JsonElement rs = j.get("rounds");
		if (rs != null && rs.isJsonArray()) {
			for (JsonElement re : rs.getAsJsonArray()) {
				if (!re.isJsonObject()) {
					continue;
				}
				JsonObject r = re.getAsJsonObject();
				int n = (int) Wire4b.num(r, "n");
				boolean isBest = n == best && v != null;
				List<Critique.Issue> is = isBest ? issues(v, "issues") : List.of();
				rounds.add(new Critique.Round(n, isBest ? Wire4b.str(v, "modelVerdict") : null, num(r.get("overall")), isBest ? scores(v) : Map.of(), is,
					List.of(), bool(r, "ship"), 0, 0, bool(r, "kept"), r.has("issues") && r.get("issues").isJsonPrimitive() ? r.get("issues").getAsInt()
						: is.size(), isBest ? Optional.ofNullable(Wire4b.str(v, "summary")) : Optional.empty(), Optional.empty(), List.of()));
			}
		}
		JsonObject cost = Wire4b.obj(j, "cost");
		Double critic = Wire4b.dbl(cost, "critic");
		Double revise = Wire4b.dbl(cost, "revise");
		String rev = Wire4b.str(j, "entryRevision");
		boolean stale = rev == null || currentRevision == null || !rev.equalsIgnoreCase(currentRevision);
		return new Critique(rounds, best, Critique.EndReason.of(Wire4b.str(j, "end")), v == null ? Double.NaN : num(v.get("overall")), v == null ? Map.of()
			: scores(v), issues(j, "openIssues"), new Cost(critic == null ? 0 : critic, 0, 0, 0, 0, 0), new Cost(revise == null ? 0 : revise, 0, 0, 0, 0, 0),
			CritiqueMode.of(Wire4b.str(j, "mode", "loop")), Optional.empty(), stale);
	}

	private record Hash(long mtime, long size, String sha) {
	}

	private static final Map<Path, Hash> HASHES = new ConcurrentHashMap<>();

	/** The sha256 (hex) of a file, cached by path, mtime and size; null when it can't be read. */
	public static @Nullable String sha256(Path file) {
		try {
			long mtime = Files.getLastModifiedTime(file).toMillis();
			long size = Files.size(file);
			Hash h = HASHES.get(file);
			if (h != null && h.mtime() == mtime && h.size() == size) {
				return h.sha();
			}
			MessageDigest md = MessageDigest.getInstance("SHA-256");
			try (InputStream in = Files.newInputStream(file)) {
				byte[] buf = new byte[65536];
				for (int n; (n = in.read(buf)) > 0;) {
					md.update(buf, 0, n);
				}
			}
			String sha = HexFormat.of().formatHex(md.digest());
			if (HASHES.size() > 4096) {
				HASHES.clear();
			}
			HASHES.put(file, new Hash(mtime, size, sha));
			return sha;
		} catch (IOException | NoSuchAlgorithmException e) {
			return null;
		}
	}

	/**
	 * A library entry's critique: {@code <dir>/critique.json} (stale when its entry revision differs from the {@code .nbt} now),
	 * else the blueprint JSON's {@code critique} summary. {@code dir} null = a bundled entry (no file).
	 */
	public static Optional<Critique> entry(@Nullable Path dir, String id, JsonObject blueprintJson) {
		if (dir != null) {
			Path f = dir.resolve(CRITIQUE_FILE);
			if (Files.isRegularFile(f)) {
				try {
					JsonObject j = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
					Path nbt = dir.resolve(id + ".nbt");
					return Optional.of(critiqueFile(j, Files.isRegularFile(nbt) ? sha256(nbt) : null));
				} catch (IOException | RuntimeException e) {
					// fall back to the summary
				}
			}
		}
		return summary(blueprintJson.get("critique"));
	}

	/**
	 * The rounds of a design's critique that have their verdict (DESIGN_CRITIQUED): scored by the critic, or kept with an error
	 * (the critic failed on it). A round that failed the check (not kept) never had a critic call.
	 */
	public static List<Critique.Round> verdictRounds(Critique c) {
		List<Critique.Round> out = new ArrayList<>();
		for (Critique.Round r : c.rounds()) {
			if (r.scored() || r.kept() && r.error().isPresent()) {
				out.add(r);
			}
		}
		return out;
	}

	/** The DESIGN_CRITIQUED dedupe key of a round: {@code designId@createdAt#n}. */
	public static String roundKey(String designId, long createdAt, int n) {
		return designId + "@" + createdAt + "#" + n;
	}

	// ------------------------------------------------------------------ estimates

	/** An {@code Estimate} with the 5a critique figures and items, when sent. */
	public static Estimate estimate(JsonObject r) {
		List<Estimate.Item> items = new ArrayList<>();
		JsonElement is = r.get("items");
		if (is != null && is.isJsonArray()) {
			for (JsonElement e : is.getAsJsonArray()) {
				if (e.isJsonObject()) {
					JsonObject i = e.getAsJsonObject();
					items.add(new Estimate.Item(Wire4b.str(i, "itemKey"), d(i, "usdLow"), d(i, "usdHigh"), d(i, "minutesLow"), d(i, "minutesHigh"),
						hasCritique(i), d(i, "critiqueUsdLow"), d(i, "critiqueUsdHigh"), d(i, "critiqueMinutesLow"), d(i, "critiqueMinutesHigh")));
				}
			}
		}
		return new Estimate(d(r, "usdLow"), d(r, "usdHigh"), d(r, "minutesLow"), d(r, "minutesHigh"), Wire4b.str(r, "basis", ""), hasCritique(r), d(r,
			"critiqueUsdLow"), d(r, "critiqueUsdHigh"), d(r, "critiqueMinutesLow"), d(r, "critiqueMinutesHigh"), items);
	}

	private static boolean hasCritique(JsonObject o) {
		return Wire4b.dbl(o, "critiqueUsdHigh") != null || Wire4b.dbl(o, "critiqueUsdLow") != null;
	}

	private static double d(JsonObject o, String k) {
		Double v = Wire4b.dbl(o, k);
		return v == null ? 0 : v;
	}

	// ------------------------------------------------------------------ bibles

	/**
	 * A bible's effective restraint (sidecar bibles.ts {@code restraintOf}): format 2's own with the defaults filled in; format 1:
	 * the defaults, hero motifs = its first 3 motifs (strings or {@code {name}} objects).
	 */
	public static Bible.Restraint restraintOf(JsonObject bibleJson) {
		List<String> motifs = new ArrayList<>();
		JsonElement ms = bibleJson.get("motifs");
		if (ms != null && ms.isJsonArray()) {
			for (JsonElement m : ms.getAsJsonArray()) {
				if (m.isJsonPrimitive()) {
					motifs.add(m.getAsString());
				} else if (m.isJsonObject() && m.getAsJsonObject().has("name") && m.getAsJsonObject().get("name").isJsonPrimitive()) {
					motifs.add(m.getAsJsonObject().get("name").getAsString());
				} else {
					motifs.add(m.toString());
				}
			}
		}
		boolean f2 = Wire4b.num(bibleJson, "format") == 2;
		JsonObject r = f2 ? Wire4b.obj(bibleJson, "restraint") : new JsonObject();
		List<String> hero = r.has("heroMotifs") && r.get("heroMotifs").isJsonArray() ? Wire4b.strings(r, "heroMotifs") : motifs;
		hero = hero.size() > 3 ? hero.subList(0, 3) : hero;
		Double asm = Wire4b.dbl(r, "accentShareMax");
		String dd = Wire4b.str(r, "detailDensity");
		Double wmin = Wire4b.dbl(r, "windowsPerFacadeMin");
		return new Bible.Restraint(hero, asm != null && asm >= 0.04 && asm <= 0.2 ? asm : Bible.Restraint.DEFAULT.accentShareMax(),
			"sparse".equals(dd) || "moderate".equals(dd) || "rich".equals(dd) ? dd : Bible.Restraint.DEFAULT.detailDensity(), wmin != null
				&& wmin >= 0 && wmin == Math.rint(wmin) ? wmin.intValue() : Bible.Restraint.DEFAULT.windowsPerFacadeMin());
	}

	/** A {@code BibleInfo.restraint} as sent (already effective), or null when absent. */
	public static Bible.@Nullable Restraint restraint(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return null;
		}
		JsonObject r = e.getAsJsonObject();
		Double asm = Wire4b.dbl(r, "accentShareMax");
		Double wmin = Wire4b.dbl(r, "windowsPerFacadeMin");
		return new Bible.Restraint(Wire4b.strings(r, "heroMotifs"), asm == null ? Bible.Restraint.DEFAULT.accentShareMax() : asm, Wire4b.str(r,
			"detailDensity", Bible.Restraint.DEFAULT.detailDensity()), wmin == null ? Bible.Restraint.DEFAULT.windowsPerFacadeMin() : wmin.intValue());
	}

	/** Whether {@code <bibles>/<id>/admin.json} says archived. */
	public static boolean archived(Path bibleDir) {
		Path f = bibleDir.resolve("admin.json");
		if (!Files.isRegularFile(f)) {
			return false;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			return bool(o, "archived");
		} catch (IOException | RuntimeException e) {
			return false;
		}
	}
}
