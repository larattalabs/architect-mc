package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.SiteBinding;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.placement.Anchors;
import java.util.Optional;
import net.minecraft.world.level.block.Rotation;
import org.jspecify.annotations.Nullable;

/**
 * (7b slice SL) A region's site lots (docs/CONTRACT.md "Phase 7b", "Slice SL as built"): an IR lot (and an artifact lot) may carry
 * {@code site}, exactly the {@link SiteSpec} wire; a pad lot carries none and every path for it is unchanged. The site is always read
 * again from the region's IR ({@link #siteOf(JsonObject, String)}), never persisted on a queue item, so the public batch API keeps
 * refusing a site ({@code apiimpl.SiteGuards.batch}). Pure. Internal.
 */
public final class SiteLots {
	private SiteLots() {
	}

	/** The IR (or artifact) member a site lot carries its site under. */
	public static final String KEY = SiteSpec.WIRE_KEY;

	/** The lot {@code lotId} of an IR's (or artifact's) {@code lots[]}, or null. */
	public static @Nullable JsonObject lotJson(@Nullable JsonObject irOrArtifact, String lotId) {
		if (irOrArtifact != null && irOrArtifact.get("lots") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject l && l.get("id") instanceof JsonElement id && id.isJsonPrimitive() && lotId.equals(id.getAsString())) {
					return l;
				}
			}
		}
		return null;
	}

	/** Whether a lot (IR or artifact json) is a site lot: it carries {@code site}. */
	public static boolean isSiteLot(@Nullable JsonObject lot) {
		return lot != null && lot.get(KEY) instanceof JsonObject;
	}

	/**
	 * A lot's site ({@link SiteSpec#fromWire}), or null for a pad lot. A malformed site throws {@link IllegalArgumentException} (the
	 * realise fails the lot's item: a site lot is never placed as a pad).
	 */
	public static @Nullable SiteSpec siteOf(@Nullable JsonObject lot) {
		return isSiteLot(lot) ? SiteSpec.fromWire(lot.getAsJsonObject(KEY)) : null;
	}

	/** {@link #siteOf(JsonObject)} of the lot {@code lotId} of an IR json. */
	public static @Nullable SiteSpec siteOf(@Nullable JsonObject ir, String lotId) {
		return siteOf(lotJson(ir, lotId));
	}

	/** The rotation's quarter turns (as {@code Rotation.ordinal()}, the placement's {@code turns}). */
	public static int turns(SiteSpec s) {
		return s.frame().rotation().ordinal();
	}

	/**
	 * Freeze before lots, the general form (SETTLEMENTS §3.4; the narrow form shipped in 6a): a site lot item freezes, before its check
	 * and capture, the columns of its site volume (the lot box + 8, within the claim) as well as its snapshot box: every column a later
	 * tile may read round the lot (a tile's warps and margins reach at most 8) keeps its pre-region heights. The y range is the
	 * snapshot's (heights are per column).
	 */
	public static Anchors.Bounds freezeBox(Anchors.Bounds snap, SiteSpec s) {
		var v = s.volume();
		return new Anchors.Bounds(Math.min(snap.minX(), v.minX()), snap.minY(), Math.min(snap.minZ(), v.minZ()), Math.max(snap.maxX(), v.maxX()), snap.maxY(),
			Math.max(snap.maxZ(), v.maxZ()));
	}

	/** The design's size turned by the site's frame: {x, y, z}. */
	public static int[] turnedSize(SiteSpec s, int sizeX, int sizeY, int sizeZ) {
		return turns(s) % 2 == 1 ? new int[] {sizeZ, sizeY, sizeX} : new int[] {sizeX, sizeY, sizeZ};
	}

	/**
	 * The bind check of a site lot bound to an entry (realiseApproved's {@code lotProblem}; nothing is written on a problem): the design's
	 * size, turned by the frame, is exactly the lot box ({@code box}: {minX..maxZ}, or the artifact's [x0, y0, z0, x1, y1, z1]), and the
	 * entry is not bound to another volume sha ({@code SITE_MISMATCH}: its {@link SiteBinding} in its ext, else its sidecar {@code site}).
	 * Null when it binds.
	 */
	public static @Nullable String bindProblem(String lotId, String entry, SiteSpec s, @Nullable JsonElement box, int sizeX, int sizeY, int sizeZ,
		@Nullable JsonObject entryJson) {
		int[] b = boxOf(box);
		if (b != null) {
			int w = b[3] - b[0] + 1, h = b[4] - b[1] + 1, d = b[5] - b[2] + 1;
			int[] t = turnedSize(s, sizeX, sizeY, sizeZ);
			if (t[0] != w || t[1] != h || t[2] != d) {
				return "lot " + lotId + ": entry " + entry + " (" + t[0] + "x" + t[1] + "x" + t[2] + " in the site's frame, "
					+ dev.larattalabs.architect.api.SiteFrame.rotationWire(s.frame().rotation()) + ") is not the site lot's box (" + w + "x" + h + "x" + d
					+ "): a site lot takes a design built for its site";
			}
		}
		Optional<String> bound = SiteFit.boundSha(entryJson);
		if (bound.isPresent() && !bound.get().equals(s.volumeSha())) {
			return "lot " + lotId + ": SITE_MISMATCH: entry " + entry + " is bound to the site volume " + bound.get() + ", not this lot's " + s.volumeSha();
		}
		return null;
	}

	/** A box as {x0, y0, z0, x1, y1, z1} from {minX..maxZ} or a 6-array; null otherwise. */
	static int @Nullable [] boxOf(@Nullable JsonElement box) {
		if (box instanceof JsonArray a && a.size() >= 6) {
			int[] o = new int[6];
			for (int i = 0; i < 6; i++) {
				o[i] = a.get(i).getAsInt();
			}
			return o;
		}
		if (box instanceof JsonObject o && o.has("minX") && o.has("maxZ")) {
			return new int[] {o.get("minX").getAsInt(), o.get("minY").getAsInt(), o.get("minZ").getAsInt(), o.get("maxX").getAsInt(), o.get("maxY").getAsInt(),
				o.get("maxZ").getAsInt()};
		}
		return null;
	}

	/** The binding a placed site lot's record carries ({@code ext["architect_mc:site"]}), with the region's plan id. */
	public static JsonObject withBinding(@Nullable JsonObject ext, SiteSpec s, @Nullable String regionPlanId) {
		JsonObject o = ext == null ? new JsonObject() : ext.deepCopy();
		o.add(SiteBinding.EXT_KEY, SiteBinding.of(s, regionPlanId).wire());
		return o;
	}

	/** The rotation of a turns count (as {@code Rotation.values()}). */
	static Rotation rotation(int turns) {
		return Rotation.values()[Math.floorMod(turns, 4)];
	}
}
