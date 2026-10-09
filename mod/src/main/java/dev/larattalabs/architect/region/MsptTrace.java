package dev.larattalabs.architect.region;

import com.google.gson.JsonObject;
import java.util.Arrays;

/**
 * DevBridge {@code dev.mspt.trace} (phase 6a): every tick's full time (start to after the last end-of-tick handler) and
 * Architect's write time in it, while on. Ticks with no Architect write slice measure what the contract leaves to vanilla
 * (lighting and chunk sending).
 */
public final class MsptTrace {
	private static final int MAX = 400_000;
	private static volatile boolean on;
	private static double[] total = new double[0];
	private static double[] work = new double[0];
	private static int n;

	private MsptTrace() {
	}

	public static synchronized JsonObject start() {
		total = new double[MAX];
		work = new double[MAX];
		n = 0;
		on = true;
		JsonObject o = new JsonObject();
		o.addProperty("started", true);
		return o;
	}

	public static void tick(long totalNanos, long workNanos) {
		if (!on) {
			return;
		}
		synchronized (MsptTrace.class) {
			if (n < MAX) {
				total[n] = totalNanos / 1e6;
				work[n] = workNanos / 1e6;
				n++;
			}
		}
	}

	public static synchronized JsonObject stop() {
		on = false;
		JsonObject o = new JsonObject();
		o.addProperty("ticks", n);
		o.add("all", stats(total, n, null, true));
		o.add("withWrites", stats(total, n, work, true));
		o.add("withoutWrites", stats(total, n, work, false));
		double ws = 0;
		double wmax = 0;
		int wt = 0;
		for (int i = 0; i < n; i++) {
			if (work[i] > 0) {
				ws += work[i];
				wt++;
				wmax = Math.max(wmax, work[i]);
			}
		}
		o.addProperty("writeTicks", wt);
		o.addProperty("writeMsMean", wt == 0 ? 0 : ws / wt);
		o.addProperty("writeMsMax", wmax);
		return o;
	}

	private static JsonObject stats(double[] t, int n, double[] w, boolean withWrites) {
		double[] a = new double[n];
		int k = 0;
		for (int i = 0; i < n; i++) {
			if (w == null || (w[i] > 0) == withWrites) {
				a[k++] = t[i];
			}
		}
		a = Arrays.copyOf(a, k);
		Arrays.sort(a);
		JsonObject o = new JsonObject();
		o.addProperty("ticks", k);
		o.addProperty("max", k == 0 ? 0 : a[k - 1]);
		o.addProperty("p99", k == 0 ? 0 : a[Math.min(k - 1, (int) Math.floor(k * 0.99))]);
		o.addProperty("p50", k == 0 ? 0 : a[k / 2]);
		double sum = 0;
		int over50 = 0;
		int over25 = 0;
		for (double v : a) {
			sum += v;
			over50 += v > 50 ? 1 : 0;
			over25 += v > 25 ? 1 : 0;
		}
		o.addProperty("mean", k == 0 ? 0 : sum / k);
		o.addProperty("over50", over50);
		o.addProperty("over25", over25);
		return o;
	}
}
