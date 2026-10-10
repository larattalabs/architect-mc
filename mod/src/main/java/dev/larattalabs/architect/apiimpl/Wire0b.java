package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Reason;
import java.util.Optional;
import java.util.OptionalInt;
import org.jspecify.annotations.Nullable;

/**
 * Slice 6c 0b (API 1.11.0) on the wire: group copies ({@code count}, {@code copyOf}, {@code copyCap}), effort
 * ({@code smallBySize}, {@code effort}), the item's kind, derivations, and the helper's typed refusals ({@code code} and
 * {@code detail} on an ok:false ack).
 */
public final class Wire0b {
	private Wire0b() {
	}

	/** The typed refusal an ok:false ack carries ({@code code}: COPY_REFUSED | VERSION_REFUSED, {@code detail}), or null. */
	public static @Nullable ArchitectRefused refusal(JsonObject ack) {
		String code = Wire4b.str(ack, "code");
		if (code == null) {
			return null;
		}
		String detail = Wire4b.str(ack, "detail", "");
		String err = Wire4b.str(ack, "error", code);
		// an unknown entry is UNKNOWN_BLUEPRINT (as everywhere else); the helper names it no_entry
		if ("VERSION_REFUSED".equals(code) && "no_entry".equals(detail)) {
			return new ArchitectRefused(Reason.UNKNOWN_BLUEPRINT, err, detail);
		}
		try {
			return new ArchitectRefused(Reason.valueOf(code), err, detail);
		} catch (IllegalArgumentException e) {
			return null;
		}
	}

	/** The 1.11.0 group fields, only when set (an older helper sees the 1.10.0 shape). */
	public static void groupFields(GroupRequest g, JsonObject o) {
		if (g.copyCap() != GroupRequest.DEFAULT_COPY_CAP) {
			o.addProperty("copyCap", g.copyCap());
		}
		if (g.smallBySize()) {
			o.addProperty("smallBySize", true);
		}
	}

	/** The 1.11.0 item fields, only when set. */
	public static void itemFields(GroupRequest.Item it, JsonObject r) {
		if (it.count() < 1 || it.count() > GroupRequest.MAX_ITEMS) {
			throw new IllegalArgumentException("an item's count is 1 to " + GroupRequest.MAX_ITEMS + " (got " + it.count() + ")");
		}
		if (it.count() > 1) {
			r.addProperty("count", it.count());
		}
		if (it.copyOf() != null) {
			r.addProperty("copyOf", it.copyOf());
		}
		if (it.effort() != GroupRequest.Item.Effort.AUTO) {
			r.addProperty("effort", it.effort().wire());
		}
	}

	/** Whether the request uses 1.11.0 group features (the helper must say {@code copies} / {@code smallEffort}). */
	public static @Nullable String feature(GroupRequest g) {
		boolean copies = g.copyCap() != GroupRequest.DEFAULT_COPY_CAP || g.items().stream().anyMatch(i -> i.count() > 1 || i.copyOf() != null);
		if (copies) {
			return "copies";
		}
		boolean small = g.smallBySize() || g.items().stream().anyMatch(i -> i.effort() != GroupRequest.Item.Effort.AUTO);
		return small ? "smallEffort" : null;
	}

	/** A group item as the helper reports it, with the 1.11.0 fields. */
	public static Group.Item item(Group.Item base, JsonObject i) {
		return new Group.Item(base.itemKey(), base.ext(), base.designId(), base.entryId(), base.status(), base.step(), base.cost(), base.wave(),
			base.role(), base.model(), base.type(), base.name(), base.error(), base.stage(), base.massing(), base.rounds(), base.designIds(),
			base.critique(), Group.Item.Kind.of(Wire4b.str(i, "kind")), Optional.ofNullable(Wire4b.str(i, "copyOf")),
			Optional.ofNullable(Wire4b.str(i, "variantJob")), Optional.ofNullable(Wire4b.str(i, "fallbackReason")),
			GroupRequest.Item.Effort.of(Wire4b.str(i, "effort")));
	}

	/** The same item with another critique (the 1.11.0 fields kept). */
	public static Group.Item withCritique(Group.Item i, Optional<dev.larattalabs.architect.api.Critique> c) {
		return new Group.Item(i.itemKey(), i.ext(), i.designId(), i.entryId(), i.status(), i.step(), i.cost(), i.wave(), i.role(), i.model(), i.type(),
			i.name(), i.error(), i.stage(), i.massing(), i.rounds(), i.designIds(), c, i.kind(), i.copyOf(), i.variantJob(), i.fallbackReason(), i.effort());
	}

	/** An entry's derivation from its blueprint JSON, if any. */
	public static Optional<Library.Derivation> derivation(JsonObject json) {
		JsonElement e = json.get("derivation");
		if (e == null || !e.isJsonObject()) {
			return Optional.empty();
		}
		JsonObject d = e.getAsJsonObject();
		String source = Wire4b.str(d, "source");
		if (source == null) {
			return Optional.empty();
		}
		JsonElement r = d.get("recipe");
		return Optional.of(new Library.Derivation(source, Math.max(1, (int) Wire4b.num(d, "sourceVersion")), Library.Derivation.Kind.of(Wire4b.str(d, "kind")),
			r != null && r.isJsonObject() ? r.getAsJsonObject().deepCopy() : new JsonObject()));
	}

	/** An entry's {@code variantOfVersion}, if any. */
	public static OptionalInt variantOfVersion(JsonObject json) {
		JsonElement e = json.get("variantOfVersion");
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? OptionalInt.of(e.getAsInt()) : OptionalInt.empty();
	}
}
