package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * PLAN_STALE (docs/CONTRACT.md phase 6b §2.4, kit/REGIONS.md "IR format 2"): an IR this game can't evaluate is refused before
 * any tile is requested, at (a) {@code region.planned} accept, (b) realise start and (c) the resume of a region record at world
 * load. Stale = IR {@code format} over the newest supported format, a {@code requires} kind outside the supported list, or an
 * IR {@code kitVersion} newer (semver) than the running kit. The mod checks against its compiled-in constants (the kit it
 * bundles: {@link #KIT_VERSION}, {@link #IR_FORMATS}, {@link #KINDS_FORMAT2}, equal to {@code kit/lib/realise.mjs} and
 * {@code kit/lib/region/plan.mjs}, a test asserts it) always, and also against the helper's {@code hello} snapshot
 * ({@code kitVersion}, {@code irFormats}, {@code irKinds}) when it is known. The message matches the kit's {@code staleReason}:
 * "plan needs kit X / format N / kinds [...]; this is kit Y" (only the parts that apply). Pure.
 */
public final class IrStale {
	/** The kit version this mod bundles ({@code KIT_VERSION} in kit/lib/region/plan.mjs). */
	public static final String KIT_VERSION = "0.12.0";
	/** {@code IR_FORMATS} in kit/lib/realise.mjs. */
	public static final List<Integer> IR_FORMATS = List.of(1, 2);
	/** {@code KINDS_FORMAT2} in kit/lib/realise.mjs (the closed list of kinds a format-2 IR's {@code requires} may name). */
	public static final List<String> KINDS_FORMAT2 = List.of("blobs:side", "fields", "forms", "material:rule", "shape:array", "shape:capsuleChain",
		"shape:ellipsoid", "shape:instances", "shape:prism", "shape:strata", "shape:warp", "shape:wedge", "volumes");

	private IrStale() {
	}

	/** The helper's versions from its {@code hello} snapshot (any part may be unknown: null / empty). */
	public record Hello(@Nullable String kitVersion, List<Integer> irFormats, List<String> irKinds) {
		public Hello {
			irFormats = irFormats == null ? List.of() : List.copyOf(irFormats);
			irKinds = irKinds == null ? List.of() : List.copyOf(irKinds);
		}

		/** From the snapshot's {@code kitVersion}, {@code irFormats}, {@code irKinds}; null when it names none of them. */
		public static @Nullable Hello of(@Nullable JsonObject snapshot) {
			if (snapshot == null || !snapshot.has("kitVersion") && !snapshot.has("irFormats") && !snapshot.has("irKinds")) {
				return null;
			}
			String kv = snapshot.has("kitVersion") && snapshot.get("kitVersion").isJsonPrimitive() ? snapshot.get("kitVersion").getAsString() : null;
			List<Integer> f = new ArrayList<>();
			if (snapshot.get("irFormats") instanceof JsonArray a) {
				a.forEach(e -> f.add(e.getAsInt()));
			}
			List<String> k = new ArrayList<>();
			if (snapshot.get("irKinds") instanceof JsonArray a) {
				a.forEach(e -> k.add(e.getAsString()));
			}
			return new Hello(kv, f, k);
		}
	}

	/** Semver compare of {@code a} and {@code b} (major.minor.patch, non-numeric parts 0), as the kit's {@code semverCompare}. */
	public static int semverCompare(String a, String b) {
		int[] pa = parts(a);
		int[] pb = parts(b);
		for (int i = 0; i < 3; i++) {
			int d = pa[i] - pb[i];
			if (d != 0) {
				return d < 0 ? -1 : 1;
			}
		}
		return 0;
	}

	private static int[] parts(String v) {
		int[] out = new int[3];
		String[] s = String.valueOf(v).split("\\.");
		for (int i = 0; i < 3 && i < s.length; i++) {
			out[i] = leadingInt(s[i]);
		}
		return out;
	}

	/** parseInt semantics of JS: the leading digits, else 0. */
	private static int leadingInt(String s) {
		int n = 0;
		int i = 0;
		boolean any = false;
		while (i < s.length() && Character.isDigit(s.charAt(i)) && i < 9) {
			n = n * 10 + (s.charAt(i) - '0');
			i++;
			any = true;
		}
		return any ? n : 0;
	}

	/**
	 * Why {@code ir} (the raw IR JSON) is too new for this game, or null. Checked against the mod's constants and, when known, the
	 * helper's {@code hello}. "This is kit Y" names the older of the two running kits (the one that refuses).
	 */
	public static @Nullable String reason(@Nullable JsonObject ir, @Nullable Hello hello) {
		if (ir == null) {
			return null;
		}
		String running = KIT_VERSION;
		if (hello != null && hello.kitVersion() != null && semverCompare(hello.kitVersion(), running) < 0) {
			running = hello.kitVersion();
		}
		List<String> why = new ArrayList<>();
		JsonElement fe = ir.get("format");
		if (fe != null && fe.isJsonPrimitive() && fe.getAsJsonPrimitive().isNumber()) {
			int f = fe.getAsInt();
			int max = IR_FORMATS.get(IR_FORMATS.size() - 1);
			if (hello != null && !hello.irFormats().isEmpty()) {
				max = Math.min(max, hello.irFormats().stream().mapToInt(Integer::intValue).max().getAsInt());
			}
			if (f > max) {
				why.add("format " + f);
			}
		}
		if (ir.get("requires") instanceof JsonArray req) {
			List<String> missing = new ArrayList<>();
			for (JsonElement e : req) {
				String k = e.isJsonPrimitive() ? e.getAsString() : e.toString();
				if (!KINDS_FORMAT2.contains(k) || hello != null && !hello.irKinds().isEmpty() && !hello.irKinds().contains(k)) {
					missing.add(k);
				}
			}
			if (!missing.isEmpty()) {
				why.add("kinds [" + String.join(", ", missing) + "]");
			}
		}
		JsonElement kv = ir.get("kitVersion");
		if (kv != null && kv.isJsonPrimitive() && semverCompare(kv.getAsString(), running) > 0) {
			why.add(0, "kit " + kv.getAsString());
		}
		return why.isEmpty() ? null : "plan needs " + String.join(" / ", why) + "; this is kit " + running;
	}

	/**
	 * The dev-only warning when the helper's kit differs from the one this mod bundles (a dev sidecar run from another checkout),
	 * or null.
	 */
	public static @Nullable String versionWarning(@Nullable Hello hello) {
		if (hello == null || hello.kitVersion() == null || hello.kitVersion().equals(KIT_VERSION)) {
			return null;
		}
		return "the helper's kit is " + hello.kitVersion() + ", this mod bundles kit " + KIT_VERSION;
	}
}
