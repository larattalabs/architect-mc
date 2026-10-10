package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.CheckReport;
import dev.larattalabs.architect.api.PreviewView;
import dev.larattalabs.architect.api.RegionPreviews;
import dev.larattalabs.architect.api.WaitAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/** Phase 6b wire shapes (kit/REGIONS.md "Phase 6b additions"): report.json -> CheckReport, previews -> RegionPreviews. Pure. */
public final class Wire6b {
	private Wire6b() {
	}

	/** {@code report.json} (or the plan's {@code report}) -> {@link CheckReport}; null when absent. */
	public static @Nullable CheckReport report(@Nullable JsonElement e) {
		if (!(e instanceof JsonObject o)) {
			return null;
		}
		List<CheckReport.Finding> fs = new ArrayList<>();
		if (o.get("findings") instanceof JsonArray a) {
			for (JsonElement fe : a) {
				if (!(fe instanceof JsonObject f)) {
					continue;
				}
				List<BlockPos> sample = new ArrayList<>();
				if (f.get("sample") instanceof JsonArray sa) {
					for (JsonElement p : sa) {
						if (p instanceof JsonArray pa && pa.size() >= 3) {
							sample.add(new BlockPos(pa.get(0).getAsInt(), pa.get(1).getAsInt(), pa.get(2).getAsInt()));
						}
					}
				}
				fs.add(new CheckReport.Finding(str(f, "rule", "?"), str(f, "severity", "warning"), str(f, "part", null), str(f, "stage", null), f.has("count")
					&& f.get("count").isJsonPrimitive() ? f.get("count").getAsInt() : 0, sample, str(f, "message", "")));
			}
		}
		int errors = o.has("errors") ? o.get("errors").getAsInt() : (int) fs.stream().filter(CheckReport.Finding::error).count();
		int warnings = o.has("warnings") ? o.get("warnings").getAsInt() : fs.size() - errors;
		boolean ok = o.has("ok") ? o.get("ok").getAsBoolean() : errors == 0;
		return new CheckReport(ok, errors, warnings, fs);
	}

	/**
	 * The previews of {@code region.planned} ({@code previews: {view: [path]}}, {@code sitePlan}) or of a {@code region.preview} ack
	 * ({@code paths}, {@code sitePlan}); null when there are none. {@code sitePlan} may be the object or the path of siteplan.json.
	 */
	public static @Nullable RegionPreviews previews(@Nullable JsonElement paths, @Nullable JsonElement sitePlan) {
		if (!(paths instanceof JsonObject p)) {
			return null;
		}
		Map<PreviewView, List<Path>> images = new EnumMap<>(PreviewView.class);
		for (Map.Entry<String, JsonElement> e : p.entrySet()) {
			PreviewView v = view(e.getKey());
			if (v == null) {
				continue;
			}
			List<Path> l = new ArrayList<>();
			if (e.getValue() instanceof JsonArray a) {
				a.forEach(x -> l.add(Path.of(x.getAsString())));
			} else if (e.getValue().isJsonPrimitive()) {
				l.add(Path.of(e.getValue().getAsString()));
			}
			images.put(v, l);
		}
		return new RegionPreviews(images, sitePlan(sitePlan));
	}

	static JsonObject sitePlan(@Nullable JsonElement e) {
		if (e instanceof JsonObject o) {
			return o;
		}
		if (e != null && e.isJsonPrimitive()) {
			try {
				Path f = Path.of(e.getAsString());
				if (Files.isRegularFile(f)) {
					return JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
				}
			} catch (Exception ex) {
				// not a readable siteplan.json: empty
			}
		}
		return new JsonObject();
	}

	/** {@code top} / {@code TOP} -> the view; null for an unknown name. */
	public static @Nullable PreviewView view(String s) {
		try {
			return PreviewView.valueOf(s.toUpperCase(Locale.ROOT));
		} catch (IllegalArgumentException e) {
			return null;
		}
	}

	/** {@link CheckReport} -> JSON (DevBridge, the commands). */
	public static JsonObject json(@Nullable CheckReport r) {
		JsonObject o = new JsonObject();
		if (r == null) {
			return o;
		}
		o.addProperty("ok", r.ok());
		o.addProperty("errors", r.errors());
		o.addProperty("warnings", r.warnings());
		JsonArray fs = new JsonArray();
		for (CheckReport.Finding f : r.findings()) {
			JsonObject j = new JsonObject();
			j.addProperty("rule", f.rule());
			j.addProperty("severity", f.severity());
			if (f.part() != null) {
				j.addProperty("part", f.part());
			}
			if (f.stage() != null) {
				j.addProperty("stage", f.stage());
			}
			j.addProperty("count", f.count());
			JsonArray s = new JsonArray();
			for (BlockPos p : f.sample()) {
				JsonArray a = new JsonArray();
				a.add(p.getX());
				a.add(p.getY());
				a.add(p.getZ());
				s.add(a);
			}
			j.add("sample", s);
			j.addProperty("message", f.message());
			fs.add(j);
		}
		o.add("findings", fs);
		return o;
	}

	/** {@link RegionPreviews} -> JSON (DevBridge, the commands): {paths: {view: [path]}, sitePlan}. */
	public static JsonObject json(@Nullable RegionPreviews p) {
		JsonObject o = new JsonObject();
		if (p == null) {
			return o;
		}
		JsonObject paths = new JsonObject();
		p.images().forEach((v, l) -> {
			JsonArray a = new JsonArray();
			l.forEach(x -> a.add(x.toString()));
			paths.add(v.name().toLowerCase(Locale.ROOT), a);
		});
		o.add("paths", paths);
		o.add("sitePlan", p.sitePlan());
		return o;
	}

	/** {@link WaitAction}s -> JSON. */
	public static JsonArray json(List<WaitAction> actions) {
		JsonArray a = new JsonArray();
		for (WaitAction w : actions) {
			JsonObject j = new JsonObject();
			j.addProperty("kind", w.kind().name());
			j.addProperty("label", w.label());
			if (w.target() != null) {
				JsonArray t = new JsonArray();
				t.add(w.target().getX());
				t.add(w.target().getY());
				t.add(w.target().getZ());
				j.add("target", t);
			}
			if (w.detail() != null) {
				j.addProperty("detail", w.detail());
			}
			a.add(j);
		}
		return a;
	}

	/** One line: "ok: 0 errors, 3 warnings (M5 x1, M8 x2)". */
	public static String summary(@Nullable CheckReport r) {
		if (r == null) {
			return "not checked";
		}
		Map<String, Integer> by = new java.util.TreeMap<>();
		r.findings().forEach(f -> by.merge(f.rule(), 1, Integer::sum));
		StringBuilder sb = new StringBuilder(r.ok() ? "ok" : "NOT ok").append(": ").append(r.errors()).append(" error").append(r.errors() == 1 ? "" : "s")
			.append(", ").append(r.warnings()).append(" warning").append(r.warnings() == 1 ? "" : "s");
		if (!by.isEmpty()) {
			List<String> parts = new ArrayList<>();
			by.forEach((k, v) -> parts.add(k + " x" + v));
			sb.append(" (").append(String.join(", ", parts)).append(')');
		}
		return sb.toString();
	}

	private static @Nullable String str(JsonObject o, String k, @Nullable String def) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : def;
	}
}
