package dev.larattalabs.architect.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7b) A lot's site, for a site-aware design, its placement and its fit (docs/CONTRACT.md "Phase 7b" §2): one record for
 * {@link DesignRequest#site()}, {@link PlaceRequest#site()}, {@link LotSpec#site()} and {@link Sites#fitToSite} (SETTLEMENTS'
 * {@code SiteLotSpec} and {@code SiteSpec} merged). The wire form ({@link #wire()}) is {@code kit/schemas/site-spec.json}. Since NEXT.
 *
 * @param volumeSha the frozen volume's ARVX sha ({@link Volume#sha()}): the site the design was made for
 * @param volumeBlobId the frozen volume's blob id ({@link Volume#blobId()})
 * @param volume the lot volume in the world: the design's allowed box plus its margin, inside the frozen volume's box
 * @param fit how the design meets the site
 * @param frame the design's frame (its own coordinates to the world, as a {@link PlaceRequest}'s origin and rotation)
 * @param keepCritical world cells that must stand as they are (a host trunk, hang points, the rock a bracket bears on): placement
 *                     refuses {@link Reason#KEEP_LOST} when one is gone. At most {@link #MAX_KEEP_CRITICAL}
 * @param ports where the graph (or the player) must arrive, in design coordinates; names unique. At most {@link #MAX_PORTS}
 * @param lotId the region lot this site is (a site lot), or null on the standalone path
 */
public record SiteSpec(String volumeSha, String volumeBlobId, BoundingBox volume, FitMode fit, SiteFrame frame, List<BlockPos> keepCritical,
	List<SitePort> ports, @Nullable String lotId) {
	/** The wire key under which a site travels in a request's or a lot's JSON. */
	public static final String WIRE_KEY = "site";
	/** The most keep-critical cells a site carries (as {@link Limits#RESERVED_CELLS_MAX}). */
	public static final int MAX_KEEP_CRITICAL = 65536;
	/** The most ports a site carries. */
	public static final int MAX_PORTS = 16;
	/** An id: a port name, an edge, a lot id, a blob id ({@code kit/schemas/site-spec.json}'s {@code id}). */
	public static final java.util.regex.Pattern ID = java.util.regex.Pattern.compile("[A-Za-z0-9_.:-]{1,64}");
	/** The widest (and tallest) port opening. */
	public static final int MAX_PORT_SIZE = 16;

	public SiteSpec {
		java.util.Objects.requireNonNull(volumeSha, "volumeSha");
		java.util.Objects.requireNonNull(volumeBlobId, "volumeBlobId");
		java.util.Objects.requireNonNull(volume, "volume");
		java.util.Objects.requireNonNull(fit, "fit");
		java.util.Objects.requireNonNull(frame, "frame");
		keepCritical = keepCritical == null ? List.of() : List.copyOf(keepCritical);
		ports = ports == null ? List.of() : List.copyOf(ports);
	}

	/**
	 * The problems of this site's shape (empty when none): a cap passed, a duplicate or over-long port name, a keep-critical cell
	 * outside {@link #volume}. Pure; whether the world still matches is the placement's question.
	 */
	public List<String> problems() {
		List<String> out = new ArrayList<>();
		if (keepCritical.size() > MAX_KEEP_CRITICAL) {
			out.add("keepCritical: " + keepCritical.size() + " cells (at most " + MAX_KEEP_CRITICAL + ")");
		}
		if (ports.size() > MAX_PORTS) {
			out.add("ports: " + ports.size() + " (at most " + MAX_PORTS + ")");
		}
		Set<String> names = new HashSet<>();
		for (SitePort p : ports) {
			if (!ID.matcher(p.name()).matches()) {
				out.add("port name \"" + p.name() + "\": 1 to 64 of A-Z a-z 0-9 _ . : -");
			}
			if (p.edge() != null && !ID.matcher(p.edge()).matches()) {
				out.add("port " + p.name() + ": edge \"" + p.edge() + "\" is not an id");
			}
			if (!p.kind().equals(SitePort.WALK) && !p.kind().equals(SitePort.DOOR)) {
				out.add("port " + p.name() + ": kind " + p.kind() + " (" + SitePort.WALK + " or " + SitePort.DOOR + ")");
			}
			if (p.width() > MAX_PORT_SIZE || p.height() > MAX_PORT_SIZE) {
				out.add("port " + p.name() + ": wider or taller than " + MAX_PORT_SIZE);
			}
			if (!names.add(p.name())) {
				out.add("port name \"" + p.name() + "\" twice");
			}
		}
		if (lotId != null && !ID.matcher(lotId).matches()) {
			out.add("lotId \"" + lotId + "\" is not an id");
		}
		for (BlockPos c : keepCritical) {
			if (!volume.isInside(c)) {
				out.add("keepCritical " + c.toShortString() + " is outside the volume");
				break;
			}
		}
		return out;
	}

	/** The wire form ({@code kit/schemas/site-spec.json}): {@code {volumeSha, volumeBlobId, volume: {minX..maxZ}, fit, frame, keepCritical, ports, lotId?}}. */
	public JsonObject wire() {
		JsonObject o = new JsonObject();
		o.addProperty("volumeSha", volumeSha);
		o.addProperty("volumeBlobId", volumeBlobId);
		o.add("volume", box(volume));
		o.addProperty("fit", fit.wire());
		o.add("frame", frame.wire());
		JsonArray k = new JsonArray();
		keepCritical.forEach(c -> k.add(pos(c)));
		o.add("keepCritical", k);
		JsonArray p = new JsonArray();
		ports.forEach(x -> p.add(x.wire()));
		o.add("ports", p);
		if (lotId != null) {
			o.addProperty("lotId", lotId);
		}
		return o;
	}

	/**
	 * The site of its wire form: checked by {@code kit/schemas/site-spec.json} (as the kit's {@code lib/siteSpec.mjs} checks it), then
	 * by {@link #problems()}; {@link IllegalArgumentException} with the first error on a malformed one.
	 */
	public static SiteSpec fromWire(JsonObject o) {
		if (o == null) {
			throw new IllegalArgumentException("site: null");
		}
		List<String> errs = SpecSchema.validate(SpecSchema.schema("site-spec"), o, "site", SpecSchema.schema("site-spec"));
		if (!errs.isEmpty()) {
			throw new IllegalArgumentException(errs.get(0));
		}
		String fitName = str(o, "fit", true);
		FitMode fit = FitMode.of(fitName).orElseThrow(() -> new IllegalArgumentException("site: unknown fit " + fitName));
		if (!(o.get("volume") instanceof JsonObject vb)) {
			throw new IllegalArgumentException("site: volume {minX, minY, minZ, maxX, maxY, maxZ} is required");
		}
		if (!(o.get("frame") instanceof JsonObject fr)) {
			throw new IllegalArgumentException("site: frame is required");
		}
		List<BlockPos> keep = new ArrayList<>();
		if (o.get("keepCritical") instanceof JsonArray a) {
			if (a.size() > MAX_KEEP_CRITICAL) {
				throw new IllegalArgumentException("site: keepCritical has " + a.size() + " cells (at most " + MAX_KEEP_CRITICAL + ")");
			}
			for (JsonElement e : a) {
				keep.add(pos(e.getAsJsonArray(), "site.keepCritical"));
			}
		}
		List<SitePort> ports = new ArrayList<>();
		if (o.get("ports") instanceof JsonArray a) {
			for (JsonElement e : a) {
				ports.add(SitePort.fromWire(e.getAsJsonObject()));
			}
		}
		SiteSpec s = new SiteSpec(str(o, "volumeSha", true), str(o, "volumeBlobId", true), boxOf(vb), fit, SiteFrame.fromWire(fr), keep, ports,
			str(o, "lotId", false));
		List<String> p = s.problems();
		if (!p.isEmpty()) {
			throw new IllegalArgumentException("site: " + String.join("; ", p));
		}
		return s;
	}

	/** {@code {minX, minY, minZ, maxX, maxY, maxZ}} (the IR's lot box shape). */
	public static JsonObject box(BoundingBox b) {
		JsonObject o = new JsonObject();
		o.addProperty("minX", b.minX());
		o.addProperty("minY", b.minY());
		o.addProperty("minZ", b.minZ());
		o.addProperty("maxX", b.maxX());
		o.addProperty("maxY", b.maxY());
		o.addProperty("maxZ", b.maxZ());
		return o;
	}

	/** The box of {@link #box}'s shape; {@link IllegalArgumentException} when a member is missing or min passes max. */
	public static BoundingBox boxOf(JsonObject o) {
		int[] v = new int[6];
		String[] k = {"minX", "minY", "minZ", "maxX", "maxY", "maxZ"};
		for (int i = 0; i < 6; i++) {
			if (!o.has(k[i])) {
				throw new IllegalArgumentException("box: " + k[i] + " is required");
			}
			v[i] = o.get(k[i]).getAsInt();
		}
		if (v[0] > v[3] || v[1] > v[4] || v[2] > v[5]) {
			throw new IllegalArgumentException("box: a min passes its max");
		}
		return new BoundingBox(v[0], v[1], v[2], v[3], v[4], v[5]);
	}

	static JsonArray pos(BlockPos p) {
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}

	static BlockPos pos(JsonArray a, String what) {
		if (a == null || a.size() != 3) {
			throw new IllegalArgumentException(what + ": [x, y, z] expected");
		}
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	static @Nullable String str(JsonObject o, String k, boolean required) {
		if (!o.has(k) || o.get(k).isJsonNull()) {
			if (required) {
				throw new IllegalArgumentException(k + " is required");
			}
			return null;
		}
		return o.get(k).getAsString();
	}
}
