package dev.larattalabs.architect.region;

import com.google.gson.JsonObject;

/** (6c F3) Test access to PlanChecks' package-private cave-form trigger. */
public final class PlanChecksF3Access {
	private PlanChecksF3Access() {
	}

	public static boolean hasCaveForm(JsonObject plan) {
		return PlanChecks.hasCaveForm(plan);
	}
}
