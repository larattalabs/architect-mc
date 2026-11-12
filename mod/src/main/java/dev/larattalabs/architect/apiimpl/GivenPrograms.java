package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BiblePin;
import dev.larattalabs.architect.api.CheckReport;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.api.ProgramRefused;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.placement.Blueprints;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * (M5 GP) Given-program designs on the mod side (docs/CONTRACT.md "M5 support", slice GP): {@link dev.larattalabs.architect.api.Designs#fromProgram},
 * {@link dev.larattalabs.architect.api.Designs#variant} and {@link dev.larattalabs.architect.api.Designs#variantByKey}.
 * <ul>
 * <li>{@code design.fromProgram {source, params, bible?, opKey, owner?}} and {@code design.variant {entryId, params, bible?, reserved?, opKey,
 * owner?}}: the helper acks with its operation and reports it done through {@code follow.upsert} (WireFS's operation channel); the
 * library reloads, then the future completes with the new entry id, or fails {@link ProgramRefused} with the helper's detail and
 * findings.</li>
 * <li>{@code design.variantByKey {opKey, owner?}}: the operation ({} = never made); a running one is waited for.</li>
 * </ul>
 * Internal.
 */
public final class GivenPrograms {
	/** The helper's feature, and the API's name for it. */
	public static final String FEATURE = "design.program";
	public static final String API_FEATURE = "givenPrograms";

	private GivenPrograms() {
	}

	/** The bible as the helper takes it: {@code {id, version?}} (version 0 or less: the latest). Pure. */
	static @Nullable JsonObject bible(@Nullable BiblePin b) {
		if (b == null) {
			return null;
		}
		if (b.id() == null || !b.id().matches("[a-z0-9_]{1,64}")) {
			throw new IllegalArgumentException("the bible id must be [a-z0-9_]{1,64} (got " + b.id() + ")");
		}
		JsonObject o = new JsonObject();
		o.addProperty("id", b.id());
		if (b.version() > 0) {
			o.addProperty("version", b.version());
		}
		return o;
	}

	private static void common(JsonObject m, JsonObject params, @Nullable BiblePin bible, String opKey, @Nullable String owner) {
		if (params == null) {
			throw new IllegalArgumentException("params must be an object (empty for the program's defaults)");
		}
		int n = params.toString().length();
		if (n > Limits.PROGRAM_PARAMS_MAX) {
			throw new ArchitectRefused(Reason.FIELD_LIMIT, "params: " + n + " characters as JSON, at most " + Limits.PROGRAM_PARAMS_MAX, "params");
		}
		if (opKey == null) {
			throw new IllegalArgumentException("a given-program design needs an opKey");
		}
		Wire0a.opKey(opKey);
		m.add("params", params.deepCopy());
		JsonObject b = bible(bible);
		if (b != null) {
			m.add("bible", b);
		}
		m.addProperty("opKey", opKey);
		if (owner != null) {
			m.addProperty("owner", owner);
		}
	}

	/** The {@code design.fromProgram} message. Throws {@link IllegalArgumentException} / FIELD_LIMIT for a bad argument. Pure. */
	static JsonObject fromProgramMessage(String source, JsonObject params, @Nullable BiblePin bible, String opKey, @Nullable String owner) {
		if (source == null || source.isEmpty()) {
			throw new IllegalArgumentException("fromProgram needs the program's source");
		}
		if (source.length() > Limits.PROGRAM_SOURCE_MAX) {
			throw new ArchitectRefused(Reason.FIELD_LIMIT, "source: " + source.length() + " characters, at most " + Limits.PROGRAM_SOURCE_MAX, "source");
		}
		JsonObject m = DesignsImpl.msg("design.fromProgram");
		m.addProperty("source", source);
		common(m, params, bible, opKey, owner);
		return m;
	}

	/** The {@code design.variant} message. Pure. */
	static JsonObject variantMessage(String entryId, JsonObject params, @Nullable BiblePin bible, DesignRequest.@Nullable Reserved reserved, String opKey,
		@Nullable String owner) {
		if (entryId == null || !entryId.matches("[a-z0-9_]{1,64}")) {
			throw new IllegalArgumentException("variant needs a library entry id (got " + entryId + ")");
		}
		JsonObject m = DesignsImpl.msg("design.variant");
		m.addProperty("entryId", entryId);
		common(m, params, bible, opKey, owner);
		if (reserved != null) {
			if (reserved.cells().size() > DesignRequest.MAX_RESERVED) {
				throw new ArchitectRefused(Reason.FIELD_LIMIT, "reserved.cells: " + reserved.cells().size() + ", at most " + DesignRequest.MAX_RESERVED, "reserved");
			}
			if (!List.of("north", "east", "south", "west").contains(reserved.front())) {
				throw new IllegalArgumentException("reserved.front must be north, east, south or west (got " + reserved.front() + ")");
			}
			if (reserved.width() < 1 || reserved.width() > 256 || reserved.depth() < 1 || reserved.depth() > 256) {
				throw new IllegalArgumentException("reserved: the lot is " + reserved.width() + " x " + reserved.depth() + " (each 1..256)");
			}
			m.add("reserved", reserved.wire());
		}
		return m;
	}

	/** The {@code design.variantByKey} message. Pure. */
	static JsonObject byKeyMessage(@Nullable String owner, String opKey) {
		if (opKey == null) {
			throw new IllegalArgumentException("variantByKey needs an opKey");
		}
		Wire0a.opKey(opKey);
		JsonObject m = DesignsImpl.msg("design.variantByKey");
		m.addProperty("opKey", opKey);
		if (owner != null) {
			m.addProperty("owner", owner);
		}
		return m;
	}

	/** The helper's refusal object {@code {code, detail, message, findings}} as the API's exception. Pure. */
	static ProgramRefused refusal(JsonObject r) {
		List<CheckReport.Finding> out = new ArrayList<>();
		if (r.get("findings") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject f) {
					out.add(new CheckReport.Finding(Wire4b.str(f, "rule", "check"), Wire4b.str(f, "severity", "error"), null, null, 1, List.of(),
						Wire4b.str(f, "message", "")));
				}
			}
		}
		String detail = Wire4b.str(r, "detail", "check");
		return new ProgramRefused(Wire4b.str(r, "message", "the given program was refused"), detail, out);
	}

	/** A finished operation as the API answers it: the new entry id, or the typed refusal. Pure. */
	static String outcome(JsonObject op) {
		String id = Wire4b.str(op, "newEntryId");
		if (id != null) {
			return id;
		}
		if (op.get("refused") instanceof JsonObject r) {
			throw refusal(r);
		}
		throw new IllegalStateException("the helper's given-program operation " + Wire4b.str(op, "id", "?") + " ended without an entry or a refusal");
	}

	/** A synchronous typed refusal from the ack (Wire0b's ArchitectRefused) with PROGRAM_REFUSED becomes a {@link ProgramRefused}. Pure. */
	static Throwable typed(Throwable t) {
		Throwable c = t instanceof CompletionException && t.getCause() != null ? t.getCause() : t;
		if (c instanceof ArchitectRefused a && !(c instanceof ProgramRefused) && a.reason() == Reason.PROGRAM_REFUSED) {
			return new ProgramRefused(a.getMessage(), a.detail(), List.of(new CheckReport.Finding(a.detail().isEmpty() ? "program" : a.detail(), "error", null, null,
				1, List.of(), a.getMessage())));
		}
		return c;
	}

	private static <T> CompletableFuture<T> failed(Throwable e) {
		return ApiImpl.onServerFuture(CompletableFuture.failedFuture(e));
	}

	/** Send, wait for the operation (its ack, or its done upsert), reload the library, answer the entry id. */
	private static CompletableFuture<String> run(JsonObject m, String what) {
		String why = DesignsImpl.unavailable4b(ApiImpl.bridge(), FEATURE, "given programs");
		if (why != null) {
			return failed(new IllegalStateException(why));
		}
		CompletableFuture<String> out = DesignsImpl.ask(FEATURE, "given programs", m).thenCompose(GivenPrograms::finished).thenApply(op -> {
			String id = outcome(op);
			Architect.LOGGER.info("API: {}: {}", what, id);
			return id;
		});
		return ApiImpl.onServerFuture(retype(out));
	}

	private static <T> CompletableFuture<T> retype(CompletableFuture<T> f) {
		CompletableFuture<T> r = new CompletableFuture<>();
		f.whenComplete((v, t) -> {
			if (t != null) {
				r.completeExceptionally(typed(t));
			} else {
				r.complete(v);
			}
		});
		return r;
	}

	/** The operation once done (its ack when already done, else its done upsert), after the library has reloaded. */
	private static CompletableFuture<JsonObject> finished(JsonObject ack) {
		CompletableFuture<JsonObject> done = "done".equals(Wire4b.str(ack, "status")) ? CompletableFuture.completedFuture(ack) : WireFS.awaitOp(Wire4b.str(ack, "id",
			""), "given program");
		return done.thenCompose(GivenPrograms::reloaded);
	}

	/** {@code Designs.fromProgram}. */
	static CompletableFuture<String> fromProgram(String source, JsonObject params, @Nullable BiblePin bible, String opKey, @Nullable String owner) {
		JsonObject m;
		try {
			m = fromProgramMessage(source, params, bible, opKey, owner);
		} catch (RuntimeException e) {
			return failed(e);
		}
		return run(m, "given program " + opKey);
	}

	/** {@code Designs.variant}. */
	static CompletableFuture<String> variant(String entryId, JsonObject params, @Nullable BiblePin bible, DesignRequest.@Nullable Reserved reserved, String opKey,
		@Nullable String owner) {
		JsonObject m;
		try {
			m = variantMessage(entryId, params, bible, reserved, opKey, owner);
		} catch (RuntimeException e) {
			return failed(e);
		}
		return run(m, "keyed variant of " + entryId + " (" + opKey + ")");
	}

	/** {@code Designs.variantByKey}. */
	static CompletableFuture<Optional<String>> variantByKey(@Nullable String owner, String opKey) {
		JsonObject m;
		try {
			m = byKeyMessage(owner, opKey);
		} catch (RuntimeException e) {
			return failed(e);
		}
		String why = DesignsImpl.unavailable4b(ApiImpl.bridge(), FEATURE, "given programs");
		if (why != null) {
			return failed(new ArchitectRefused(Reason.SIDECAR_UNAVAILABLE, why));
		}
		CompletableFuture<Optional<String>> out = DesignsImpl.ask(FEATURE, "given programs", m).thenCompose(ack -> {
			if (Wire4b.str(ack, "id") == null) {
				return CompletableFuture.completedFuture(Optional.<String>empty());
			}
			return finished(ack).thenApply(op -> Optional.of(outcome(op)));
		});
		return ApiImpl.onServerFuture(retype(out));
	}

	/** The library reloads (the new entry), on the server thread, before the future completes. */
	private static CompletableFuture<JsonObject> reloaded(JsonObject op) {
		MinecraftServer s = ApiImpl.server();
		if (s == null || Wire4b.str(op, "newEntryId") == null) {
			return CompletableFuture.completedFuture(op);
		}
		CompletableFuture<JsonObject> out = new CompletableFuture<>();
		s.execute(() -> {
			try {
				Blueprints.reload(s);
			} catch (RuntimeException e) {
				Architect.LOGGER.warn("API: reload after a given program failed", e);
			}
			out.complete(op);
		});
		return out;
	}
}
