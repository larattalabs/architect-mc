package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.library.LibraryMeta;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * {@link Library} over {@link Blueprints} (reads) and the client's Library feature (delete, tags) and sidecar link
 * (variants). Internal.
 */
final class LibraryImpl implements Library {
	/**
	 * Variant jobs a {@link #makeVariant} waits for, by variant id, with the variant timeout; an outcome that arrives before
	 * the ack registered its future is kept for a minute (a fast variant finishes before the ack is processed).
	 */
	private final PendingFutures<Entry> waiting = new PendingFutures<>("variant", 60_000);

	@Override
	public List<Entry> list() {
		LibraryMeta.Overlay overlay = overlay();
		List<Entry> out = new ArrayList<>();
		for (Blueprints.Entry e : Blueprints.entries()) {
			out.add(view(e, overlay));
		}
		return List.copyOf(out);
	}

	@Override
	public Optional<Entry> get(String id) {
		Blueprints.Entry e = Blueprints.entry(id);
		return e == null ? Optional.empty() : Optional.of(view(e, e.bundled() ? overlay() : null));
	}

	private static LibraryMeta.Overlay overlay() {
		return new LibraryMeta.Overlay(Blueprints.gameDataDir().resolve("library-meta.json")).load();
	}

	private static Entry view(Blueprints.Entry e, LibraryMeta.@Nullable Overlay overlay) {
		LibraryMeta meta = e.bundled() && overlay != null ? overlay.get(e.blueprint().id()) : LibraryMeta.read(e.json());
		return Views.entry(e, meta);
	}

	@Override
	public void reload() {
		MinecraftServer s = ApiImpl.server();
		if (s == null) {
			return;
		}
		if (s.isSameThread()) {
			Blueprints.reload(s);
		} else {
			s.execute(() -> Blueprints.reload(s));
		}
	}

	@Override
	public CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name) {
		return makeVariant(entryId, palette, values, name, null, null);
	}

	@Override
	public CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name,
		@Nullable String bible) {
		return makeVariant(entryId, palette, values, name, bible, null);
	}

	@Override
	public CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name,
		@Nullable String bible, @Nullable Integer bibleVersion) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null || !b.connected()) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException("the design helper is not running")));
		}
		boolean hasPalette = palette != null && !palette.isJsonNull();
		// (Style unification U1) roles inline: a helper without palette.roles strips the bible and builds the default palette, silently
		if (hasPalette && palette.isJsonObject() && palette.getAsJsonObject().has("bible") && !b.sidecarFeatures().contains("palette.roles")) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException(
				"a variant with a Style's roles needs a helper with palette.roles (Style unification U1); this one does not have it")));
		}
		if (bible != null) {
			String why = hasPalette ? "a variant takes a palette or a bible, not both" : DesignsImpl.unavailable4b(b, "reskin", "re-skins with a bible");
			if (why != null) {
				return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalArgumentException(why)));
			}
		}
		JsonObject payload = new JsonObject();
		payload.addProperty("from", entryId);
		if (hasPalette) {
			payload.add("palette", palette.deepCopy());
		}
		if (bible != null) {
			payload.add("bible", Wire4b.bibleRef(bible, bibleVersion));
		}
		if (values != null && values.size() > 0) {
			payload.add("values", values.deepCopy());
		}
		if (name != null && !name.isBlank()) {
			payload.addProperty("name", name.strip());
		}
		CompletableFuture<Entry> done = new CompletableFuture<>();
		b.variantRequest(payload).whenComplete((id, err) -> {
			if (err != null) {
				done.completeExceptionally(err);
			} else {
				waiting.await(id, done, System.currentTimeMillis(), ApiTimeouts.VARIANT_MS);
			}
		});
		return ApiImpl.onServerFuture(done);
	}

	// ------------------------------------------------------------------ 6c SCH: Sponge schematics

	@Override
	public CompletableFuture<Entry> importSchematic(Path file, @Nullable String name) {
		return importSchematic(file, name, null);
	}

	@Override
	public CompletableFuture<Entry> importSchematic(Path file, @Nullable String name, @Nullable JsonObject ext) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null || !b.connected()) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException("the design helper is not running")));
		}
		if (!b.sidecarFeatures().contains("import.schem")) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException(
				"the design helper is too old to import schematics (it lacks import.schem): update it")));
		}
		if (file == null) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalArgumentException("no file")));
		}
		String fileName = file.getFileName().toString();
		// read, upgrade and check off the server thread; every refusal comes before anything is staged
		CompletableFuture<dev.larattalabs.architect.library.Schematics.Staged> staged = CompletableFuture.supplyAsync(() -> {
			try {
				var st = dev.larattalabs.architect.library.Schematics.stageImport(Blueprints.gameDataDir(), file, name, ext);
				var prep = st.prepared();
				Architect.LOGGER.info("API: schematic {} (v{}, DataVersion {}) read and upgraded{}", fileName, prep.parsed().version(), prep.parsed()
					.dataVersion(), prep.notes().isEmpty() ? "" : ": " + String.join("; ", prep.notes()));
				return st;
			} catch (dev.larattalabs.architect.library.Schematic.Refused r) {
				throw new java.util.concurrent.CompletionException(new dev.larattalabs.architect.api.ArchitectRefused(r.reason(), fileName + ": " + r
					.getMessage()));
			} catch (java.nio.file.NoSuchFileException e) {
				throw new java.util.concurrent.CompletionException(new IllegalArgumentException("no file " + file));
			} catch (IOException e) {
				throw new java.util.concurrent.CompletionException(e);
			}
		});
		CompletableFuture<Entry> done = new CompletableFuture<>();
		staged.whenComplete((st, err) -> {
			if (err != null) {
				done.completeExceptionally(err instanceof java.util.concurrent.CompletionException && err.getCause() != null ? err.getCause() : err);
				return;
			}
			b.send(st.message()).whenComplete((ack, e2) -> {
				if (e2 == null && ack.has("ok") && ack.get("ok").getAsBoolean() && ack.has("result") && ack.getAsJsonObject("result").has("variantId")) {
					waiting.await(ack.getAsJsonObject("result").get("variantId").getAsString(), done, System.currentTimeMillis(), ApiTimeouts.VARIANT_MS);
				} else {
					done.completeExceptionally(e2 != null ? e2 : new IllegalStateException("the helper refused the import: " + (ack.has("error") ? ack.get(
						"error").getAsString() : ack)));
				}
			});
		});
		done.whenComplete((e, err) -> {
			staged.thenAccept(st -> dev.larattalabs.architect.library.Schematics.unstage(st.file()));
		});
		return ApiImpl.onServerFuture(done);
	}


	@Override
	public CompletableFuture<Path> exportSchematic(String entryId, @Nullable Integer version, Path dir) {
		MinecraftServer s = ApiImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new dev.larattalabs.architect.api.ArchitectRefused(dev.larattalabs.architect.api.Reason.WORLD_STOPPED,
				"no world is running"));
		}
		if (entryId == null || dir == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("an entry id and a folder are needed"));
		}
		// the template is read on the server thread (versions go through its fixers); encoded and written off it
		CompletableFuture<Object[]> read = CompletableFuture.supplyAsync(() -> {
			Blueprints.Entry e = Blueprints.entry(entryId);
			if (e == null) {
				throw new dev.larattalabs.architect.api.ArchitectRefused(dev.larattalabs.architect.api.Reason.UNKNOWN_BLUEPRINT, "no library entry " + entryId);
			}
			if (version != null) {
				Blueprints.Version v = Blueprints.version(s, entryId, version);
				if (v == null) {
					throw new dev.larattalabs.architect.api.ArchitectRefused(dev.larattalabs.architect.api.Reason.VERSION_GONE, "version " + version + " of "
						+ entryId + " is unknown or was garbage-collected");
				}
				e = v.entry();
			}
			var bp = e.blueprint();
			return new Object[] {dev.larattalabs.architect.library.Schematics.templateTag(e.template()), bp.name(), bp.createdAt(), bp.groundY()};
		}, s);
		return ApiImpl.onServerFuture(read.thenApplyAsync(r -> {
			byte[] bytes = dev.larattalabs.architect.library.Schematics.encode((net.minecraft.nbt.CompoundTag) r[0], (String) r[1], (Long) r[2],
				(Integer) r[3]);
			try {
				Path out = dev.larattalabs.architect.library.Schematics.write(dir, dev.larattalabs.architect.library.Schematics.exportName(entryId, version),
					bytes);
				Architect.LOGGER.info("API: {} exported as a schematic: {} ({} bytes)", entryId, out, bytes.length);
				return out;
			} catch (IOException ex) {
				throw new java.util.concurrent.CompletionException(ex);
			}
		}));
	}

	/** Fails the variant and re-skin futures past their timeout (any thread). */
	void expire(long now) {
		waiting.expire(now);
		reskinWaiting.expire(now);
	}

	/**
	 * The link dropped: every waiting variant future fails. Returns how many. (A re-skin's future keeps waiting: its record
	 * lives in the sidecar's state and comes back with the next snapshot.)
	 */
	int linkLost() {
		return waiting.failAll("the Architect helper disconnected before the variant finished");
	}

	// ------------------------------------------------------------------ re-skins (4b)

	/** Re-skin futures by reskin id (completed with the final record after the library reload). */
	private final PendingFutures<dev.larattalabs.architect.api.Reskin> reskinWaiting = new PendingFutures<>("re-skin", 10 * 60_000L);
	final RecordBook reskins = new RecordBook("re-skin", Blueprints.gameDataDir().resolve("api-reskins.json"), 50,
		r -> dev.larattalabs.architect.api.Reskin.Status.of(RecordBook.str(r, "status")).isFinal(), r -> new JobLedger.Mark(RecordBook.str(r, "status"),
			RecordBook.str(r, "step"), RecordBook.num(r, "updatedAt"), 0));

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.Reskin> reskinCollection(String bibleId, @Nullable Integer version, CollectionRef from) {
		JsonObject m = DesignsImpl.msg("reskin.request");
		m.addProperty("bibleId", bibleId);
		if (version != null) {
			m.addProperty("version", version);
		}
		m.add("from", Wire4b.collection(from));
		CompletableFuture<dev.larattalabs.architect.api.Reskin> done = new CompletableFuture<>();
		DesignsImpl.ask("reskin", "re-skins", m).whenComplete((res, err) -> {
			if (err != null) {
				done.completeExceptionally(err);
				return;
			}
			String id = res.has("reskinId") ? res.get("reskinId").getAsString() : null;
			if (id == null) {
				done.completeExceptionally(new IllegalStateException("the helper sent no reskinId"));
				return;
			}
			Architect.LOGGER.info("API: re-skin {} with {} ({} variant(s))", id, bibleId, res.has("variantIds") ? res.getAsJsonArray("variantIds").size()
				: 0);
			// one that finished before the ack was processed left its outcome in reskinWaiting: await settles it at once
			reskinWaiting.await(id, done, System.currentTimeMillis(), 10 * 60_000L);
		});
		return ApiImpl.onServerFuture(done);
	}

	/** {@code reskin.upsert} / a snapshot's reskin (any thread). */
	void reskinChanged(JsonObject raw) {
		JsonObject r = reskins.merge(raw);
		if (r != null) {
			ApiImpl.runOnServer(() -> fireReskin(r));
		}
	}

	/** Server thread: once final, reload (its entries), complete its future and fire RESKIN_DONE, once. */
	void fireReskin(JsonObject raw) {
		RecordBook.Firing f = reskins.fire(raw);
		if (!f.done()) {
			return;
		}
		dev.larattalabs.architect.api.Reskin r = Wire4b.reskin(raw);
		MinecraftServer s = ApiImpl.server();
		if (s != null && r.entries().stream().anyMatch(id -> Blueprints.entry(id) == null)) {
			Blueprints.reload(s);
		}
		reskinWaiting.complete(r.id(), r, System.currentTimeMillis());
		ApiEvents.reskinDone(r);
	}

	/** A world loaded (server thread). */
	void catchUpReskins() {
		reskins.pendingDone().forEach(this::fireReskin);
	}

	/**
	 * A variant job finished (from the client's sidecar state, server thread; deferred to the next world when none ran):
	 * reloads, then completes its future (also one registered later) and fires VARIANT_DONE.
	 */
	void variantFinished(MinecraftServer server, String variantId, boolean ok, @Nullable String blueprintId, @Nullable String error, boolean isImport) {
		long now = System.currentTimeMillis();
		if (!ok || blueprintId == null) {
			waiting.fail(variantId, new IllegalStateException(error == null ? "the variant failed" : error), now);
			return;
		}
		if (Blueprints.entry(blueprintId) == null) {
			Blueprints.reload(server);
		}
		Optional<Entry> e = get(blueprintId);
		if (e.isEmpty()) {
			waiting.fail(variantId, new IllegalStateException("variant " + blueprintId + " is not in the library after a reload"), now);
			return;
		}
		waiting.complete(variantId, e.get(), now);
		if (!isImport) {
			ApiEvents.variantDone(e.get());
		}
	}

	@Override
	public CompletableFuture<Boolean> delete(String entryId) {
		if (dev.larattalabs.architect.site.Adopt.deleteRefusal(entryId) != null) {
			return CompletableFuture.completedFuture(false); // (6c PT2) an adopted entry whose site stands: the site pins it
		}
		ClientBridge b = ApiImpl.bridge();
		if (b == null) {
			return CompletableFuture.completedFuture(false);
		}
		return ApiImpl.onServerFuture(b.deleteEntry(entryId));
	}

	@Override
	public void setExt(String entryId, String key, @Nullable JsonElement value) {
		if (!ApiRules.extKeyValid(key)) {
			throw new IllegalArgumentException("ext keys are namespaced: <modid>:<key> (got " + key + ")");
		}
		Blueprints.Entry e = Blueprints.entry(entryId);
		if (e == null) {
			throw new IllegalArgumentException("no library entry " + entryId);
		}
		if (e.bundled() || e.dir() == null) {
			throw new IllegalArgumentException(entryId + " is bundled (read-only, in the jar): its ext can't change");
		}
		Path file = e.dir().resolve(entryId + Blueprints.SIDECAR_SUFFIX);
		try {
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			JsonObject ext = o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject();
			if (value == null || value.isJsonNull()) {
				ext.remove(key);
			} else {
				ext.add(key, value.deepCopy());
			}
			if (ext.size() == 0) {
				o.remove("ext");
			} else {
				o.add("ext", ext);
			}
			LibraryMeta.writeAtomically(file, LibraryMeta.pretty(o));
		} catch (IOException | RuntimeException ex) {
			throw new IllegalStateException("could not write the ext of " + entryId + ": " + ex.getMessage(), ex);
		}
		Architect.LOGGER.info("Library: {} ext {} = {}", entryId, key, value);
		MinecraftServer s = ApiImpl.server();
		if (s != null && s.isSameThread()) {
			Blueprints.reload(s);
		} else {
			reload();
		}
	}

	/** Merges {@code ext} into a user entry's blueprint JSON (a design's request ext); false when bundled or unknown. */
	static boolean mergeExt(String entryId, JsonObject ext) {
		Blueprints.Entry e = Blueprints.entry(entryId);
		Path dir = e != null ? e.dir() : Blueprints.userDir().resolve(entryId);
		if (e != null && e.bundled() || dir == null) {
			return false;
		}
		Path file = dir.resolve(entryId + Blueprints.SIDECAR_SUFFIX);
		if (!Files.isRegularFile(file)) {
			return false;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			JsonObject cur = o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject();
			boolean changed = false;
			for (var en : ext.entrySet()) {
				if (!en.getValue().equals(cur.get(en.getKey()))) {
					cur.add(en.getKey(), en.getValue().deepCopy());
					changed = true;
				}
			}
			if (changed) {
				o.add("ext", cur);
				LibraryMeta.writeAtomically(file, LibraryMeta.pretty(o));
			}
			return true;
		} catch (IOException | RuntimeException ex) {
			Architect.LOGGER.warn("Could not copy the request's ext into {}", file, ex);
			return false;
		}
	}

	@Override
	public void setTags(String entryId, List<String> userTags) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null) {
			throw new IllegalStateException("tags are kept by the client's Library; no client here");
		}
		// a user entry's tags are written into its blueprint JSON: reload, so list()/get() show them (bundled ones read the overlay)
		b.setTags(entryId, userTags == null ? List.of() : List.copyOf(userTags)).whenComplete((v, e) -> {
			if (e != null) {
				Architect.LOGGER.warn("Library: setting the tags of {} failed: {}", entryId, e.getMessage());
			} else {
				reload();
			}
		});
	}

	// ------------------------------------------------------------------ phase 5b: versions

	@Override
	public List<dev.larattalabs.architect.api.EntryVersion> versions(String entryId) {
		Blueprints.Entry e = Blueprints.entry(entryId);
		return e == null ? List.of() : Views.entryVersions(entryId, e.json());
	}

	// ------------------------------------------------------------------ 6c 0a: caller pins

	@Override
	public CompletableFuture<Void> pinVersion(String entryId, int version, String owner) {
		MinecraftServer s = ApiImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new dev.larattalabs.architect.api.ArchitectRefused(dev.larattalabs.architect.api.Reason.WORLD_STOPPED,
				"no world is running"));
		}
		if (owner == null || owner.isBlank()) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("a pin needs an owner"));
		}
		return ApiImpl.onServerFuture(CompletableFuture.supplyAsync(() -> {
			if (Blueprints.version(s, entryId, version) == null) {
				throw new dev.larattalabs.architect.api.ArchitectRefused(dev.larattalabs.architect.api.Reason.VERSION_GONE, "version " + version + " of "
					+ entryId + " is unknown or was garbage-collected");
			}
			if (CallerPins.pin(entryId, version, owner)) {
				dev.larattalabs.architect.Architect.LOGGER.info("API: {} v{} pinned by {}", entryId, version, owner);
				Versioned.sendPins();
			}
			return (Void) null;
		}, s));
	}

	@Override
	public CompletableFuture<Void> unpinVersion(String entryId, int version, String owner) {
		if (CallerPins.unpin(entryId, version, owner)) {
			dev.larattalabs.architect.Architect.LOGGER.info("API: {} v{} unpinned by {}", entryId, version, owner);
			MinecraftServer s = ApiImpl.server();
			if (s != null) {
				s.execute(Versioned::sendPins);
			}
		}
		return CompletableFuture.completedFuture(null);
	}

	@Override
	public List<String> pinOwners(String entryId, int version) {
		return CallerPins.owners(entryId, version);
	}

	@Override
	public Optional<Entry> entry(String entryId, int version) {
		MinecraftServer s = ApiImpl.server();
		if (s == null) {
			return Optional.empty();
		}
		Blueprints.Version v = Blueprints.version(s, entryId, version);
		if (v == null) {
			return Optional.empty();
		}
		return Optional.of(view(v.entry(), v.entry().bundled() ? overlay() : null));
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.BlueprintDelta> delta(String entryId, int from, int to) {
		MinecraftServer s = ApiImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no running server"));
		}
		// the versions are read on the server thread (templates go through its fixers); the diff runs off it
		CompletableFuture<Blueprints.Version[]> vs = s.isSameThread() ? CompletableFuture.completedFuture(new Blueprints.Version[] {Blueprints.version(s,
			entryId, from), Blueprints.version(s, entryId, to)}) : CompletableFuture.supplyAsync(() -> new Blueprints.Version[] {Blueprints.version(s,
				entryId, from), Blueprints.version(s, entryId, to)}, s);
		return ApiImpl.onServerFuture(vs.thenApplyAsync(v -> {
			if (v[0] == null || v[1] == null) {
				throw new IllegalArgumentException("no version " + (v[0] == null ? from : to) + " of " + entryId);
			}
			return Views.blueprintDelta(entryId, from, to, dev.larattalabs.architect.site.SiteDeltas.templateDelta(v[0], v[1]));
		}));
	}

	@Override
	public CompletableFuture<Entry> revertEntry(String entryId, int toVersion) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null || !b.connected()) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException("the design helper is not running")));
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "entry.revert");
		m.addProperty("entryId", entryId);
		m.addProperty("toVersion", toVersion);
		CompletableFuture<Entry> done = new CompletableFuture<>();
		b.send(m).whenComplete((ack, err) -> {
			if (err != null) {
				done.completeExceptionally(err);
				return;
			}
			if (!ack.has("ok") || !ack.get("ok").getAsBoolean()) {
				done.completeExceptionally(new IllegalStateException(ack.has("error") ? ack.get("error").getAsString() : "the helper refused the revert"));
				return;
			}
			MinecraftServer s = ApiImpl.server();
			if (s == null) {
				done.completeExceptionally(new IllegalStateException("no running server"));
				return;
			}
			s.execute(() -> {
				Blueprints.reload(s);
				Optional<Entry> e = get(entryId);
				if (e.isPresent()) {
					done.complete(e.get());
				} else {
					done.completeExceptionally(new IllegalStateException(entryId + " is gone"));
				}
			});
		});
		return ApiImpl.onServerFuture(done);
	}
}
