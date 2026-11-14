package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * {@link Regions#realise}. Since 1.8.0.
 *
 * @param mode INSTANT (or AUTO in a creative or survival-toggle-off world); CONSTRUCTION refuses NOT_ALLOWED
 * @param lotEntries lot id -> library entry id ({@code id} or {@code id@version}); unmapped lots stay pads
 * @param load null: {@code GENERATED_ONLY(max(64, the largest item's chunks + 36))}; {@code LOADED_ONLY} for staged builds near
 *             the player (no tickets, no prepare needed)
 * @param stages null: every stage of the plan, in order
 * @param force realise although the land drifted from the plan at region start ({@link Reason#DRIFTED}) or the claim overlaps
 *              another owner's region
 * @param maxWaitSeconds 0 (the default): the region's items wait without a time limit (Steward S8; the wait reason is shown in
 *              {@link RegionView#waiting()}). Above 0, opt-in: an item that has waited that long in all, for any reason (the
 *              player's chunks, the helper, its turn for the chunk budget), fails {@link Reason#TIMED_OUT} with the wait reason in
 *              its message. A stage held for drift is not an item wait and does not count.
 * @param opKey (since 1.14.0) the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}}), scoped by (the plan's owner, "region.realise",
 *     opKey); a null key is the old behaviour. The same key with the same body returns the existing realise's region id, in any state
 *     (also while the realise is still starting); with a different body the future fails {@link ArchitectRefused}
 *     {@link Reason#OP_KEY_CONFLICT}. The body is every other component (the actor by UUID). Found after a restart by
 *     {@link Regions#realiseByKey}, including a realise that was interrupted and resumed; kept as long as the region exists (removing the
 *     region ends its key). The plan's lot {@code ext} needs no request member: the realise copies it onto each lot's site.
 * @param maxBill (BC, S-M5-9, since NEXT) null: no cap. Else the most the realise may consume in survival, item id -> count (the bound the
 *     caller approved, e.g. its quote's {@code bom}); an item it does not name may not be consumed at all. The realise is refused
 *     {@link Reason#BILL_CAP} before anything is reserved or written when its bill at put-down ({@link Regions#quote} of the plan with these
 *     entries, the same reading) is past it. Then, while it builds, what its targets draw (net of a swap's or a removal's refunds) never
 *     passes it: a target whose next cell would draw past it waits with {@link SiteWait#BILL_CAP} (STARVED in {@code Sites.view}) instead
 *     of consuming, however much the stockpile holds. Kept with the region across a restart. A revision's cap counts its own draws from
 *     its realise on. Ignored in creative (nothing is consumed). Counts must be at least 0
 */
public record RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
	boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext, int maxWaitSeconds, @Nullable String opKey,
	@Nullable BuildConsent consent, @Nullable Map<String, Integer> maxBill) {
	public RealiseRequest {
		mode = mode == null ? Mode.AUTO : mode;
		lotEntries = lotEntries == null ? Map.of() : Map.copyOf(lotEntries);
		stages = stages == null ? null : List.copyOf(stages);
		ext = ext == null ? new JsonObject() : ext;
		maxWaitSeconds = Math.max(0, maxWaitSeconds);
		maxBill = capOf(maxBill);
	}

	/** (BC) A cap's copy, sorted; a negative or missing count is refused. */
	static @Nullable Map<String, Integer> capOf(@Nullable Map<String, Integer> m) {
		if (m == null) {
			return null;
		}
		java.util.TreeMap<String, Integer> o = new java.util.TreeMap<>();
		m.forEach((k, v) -> {
			if (k == null || v == null || v < 0) {
				throw new IllegalArgumentException("maxBill: " + k + " -> " + v + " (an item id and a count of at least 0)");
			}
			o.put(k, v);
		});
		return java.util.Collections.unmodifiableMap(o);
	}

	/** (PT) The 1.14.0+ shape with a consent: no cap. */
	public RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
		boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext, int maxWaitSeconds, @Nullable String opKey,
		@Nullable BuildConsent consent) {
		this(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, maxWaitSeconds, opKey, consent, null);
	}

	/** (BC, since NEXT) The same request with this cap ({@link #maxBill}; null: none). */
	public RealiseRequest withMaxBill(@Nullable Map<String, Integer> cap) {
		return new RealiseRequest(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, maxWaitSeconds, opKey, consent, cap);
	}

	/** (PT) Without a consent (the 1.14.0+ shape). */
	public RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
		boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext, int maxWaitSeconds, @Nullable String opKey) {
		this(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, maxWaitSeconds, opKey, null, null);
	}

	/** (PT) The same request with this consent (a build it names is no keep-out, S-PT-4). */
	public RealiseRequest withConsent(@Nullable BuildConsent c) {
		return new RealiseRequest(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, maxWaitSeconds, opKey, c, maxBill);
	}

	/** The 1.13.0 constructor (no opKey). */
	public RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
		boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext, int maxWaitSeconds) {
		this(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, maxWaitSeconds, null, null, null);
	}

	/** Without a wait limit (S8's default) or an opKey. */
	public RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
		boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext) {
		this(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, 0, null, null, null);
	}
}
