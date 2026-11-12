package dev.larattalabs.architect.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7c) A composite library entry's modules and joints (docs/CONTRACT.md "Phase 7c" §2, SETTLEMENTS §12): a structure past
 * 96x64x96 made of modules, each an ordinary entry within the cap, joined at {@code architect:joint} ports. Stored in the composite
 * entry's {@code ext} under {@link #EXT_KEY}, so {@link Library.Entry} gains no component; read with {@link #of(Library.Entry)}. The
 * module entries are hidden from the Library. A composite is one entry and one group item (Steward's {@code itemKey == lotId} binding
 * holds). Frozen by the 7c foundation; written by slice CM-b (feature {@code "composites"}), which also refuses
 * {@link Reason#JOINT_MISMATCH}. Since NEXT.
 *
 * @param moduleEntryIds the module entries, in support order (a module that rests on another follows it)
 * @param joints the joints between modules
 * @param union the composite's whole box, in the composite's own design coordinates (every module's box inside it)
 */
public record CompositeInfo(List<String> moduleEntryIds, List<Joint> joints, BoundingBox union) {
	/** The key in {@link Library.Entry#ext()}. */
	public static final String EXT_KEY = "architect_mc:composite";

	public CompositeInfo {
		moduleEntryIds = List.copyOf(Objects.requireNonNull(moduleEntryIds, "moduleEntryIds"));
		joints = List.copyOf(Objects.requireNonNull(joints, "joints"));
		Objects.requireNonNull(union, "union");
	}

	/**
	 * One joint: a pair of {@code architect:joint} ports, one on each module, at the same cell boundary with opposite facings and the
	 * same width and height (the geometry is the ports' own, in each module's entry). Since NEXT.
	 *
	 * @param fromModule the first module's entry id (one of {@link #moduleEntryIds()})
	 * @param fromPort the first module's port name
	 * @param toModule the second module's entry id
	 * @param toPort the second module's port name
	 */
	public record Joint(String fromModule, String fromPort, String toModule, String toPort) {
		public Joint {
			Objects.requireNonNull(fromModule, "fromModule");
			Objects.requireNonNull(fromPort, "fromPort");
			Objects.requireNonNull(toModule, "toModule");
			Objects.requireNonNull(toPort, "toPort");
		}

		/** The wire form: {@code {from: {module, port}, to: {module, port}}}. */
		public JsonObject wire() {
			JsonObject o = new JsonObject();
			o.add("from", end(fromModule, fromPort));
			o.add("to", end(toModule, toPort));
			return o;
		}

		private static JsonObject end(String module, String port) {
			JsonObject e = new JsonObject();
			e.addProperty("module", module);
			e.addProperty("port", port);
			return e;
		}
	}

	/** An entry's composite: empty when the entry is not a composite, or its {@code ext} member is malformed. Never throws. */
	public static Optional<CompositeInfo> of(Library.Entry entry) {
		return entry == null ? Optional.empty() : ofExt(entry.ext());
	}

	/** The composite in an {@code ext} object: empty when there is none or it is malformed. Never throws. */
	public static Optional<CompositeInfo> ofExt(@Nullable JsonObject ext) {
		if (ext == null || !(ext.get(EXT_KEY) instanceof JsonObject o)) {
			return Optional.empty();
		}
		try {
			if (!(o.get("modules") instanceof JsonArray ms) || !(o.get("joints") instanceof JsonArray js) || !(o.get("union") instanceof JsonObject u)) {
				return Optional.empty();
			}
			List<String> modules = new ArrayList<>();
			for (JsonElement m : ms) {
				modules.add(m.getAsString());
			}
			List<Joint> joints = new ArrayList<>();
			for (JsonElement j : js) {
				JsonObject jo = j.getAsJsonObject();
				JsonObject f = jo.getAsJsonObject("from"), t = jo.getAsJsonObject("to");
				joints.add(new Joint(f.get("module").getAsString(), f.get("port").getAsString(), t.get("module").getAsString(), t.get("port").getAsString()));
			}
			return Optional.of(new CompositeInfo(modules, joints, SiteSpec.boxOf(u)));
		} catch (RuntimeException e) {
			return Optional.empty();
		}
	}

	/** The wire form under {@link #EXT_KEY}: {@code {modules: [entryId...], joints: [{from, to}...], union: {minX..maxZ}}}. */
	public JsonObject wire() {
		JsonObject o = new JsonObject();
		JsonArray ms = new JsonArray();
		moduleEntryIds.forEach(ms::add);
		o.add("modules", ms);
		JsonArray js = new JsonArray();
		joints.forEach(j -> js.add(j.wire()));
		o.add("joints", js);
		o.add("union", SiteSpec.box(union));
		return o;
	}
}
