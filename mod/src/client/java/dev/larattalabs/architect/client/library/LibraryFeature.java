package dev.larattalabs.architect.client.library;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.design.DesignForm;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.hud.Toasts;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarLink;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.client.sidecar.SidecarState.Variant;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.library.Exchange;
import dev.larattalabs.architect.library.LibraryCard;
import dev.larattalabs.architect.library.LibraryMeta;
import dev.larattalabs.architect.library.LibraryQuery;
import dev.larattalabs.architect.library.Palettes;
import dev.larattalabs.architect.library.VariantForm;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.UnaryOperator;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplateManager;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * The library, mod side (docs/CONTRACT.md "Mod: library screen"): the cards with user metadata applied, the filters and
 * sort, the selection, metadata edits (in place for user entries, the overlay {@code library-meta.json} for bundled
 * ones: {@link LibraryMeta}), delete to the trash, export, the import list and {@code import.request}, the Variants
 * dialog's model and {@code variant.request}, remix, and the library reload when a variant or import is done. The
 * Library tab draws it; the DevBridge drives the same actions. Client thread.
 */
public final class LibraryFeature {
	private static LibraryQuery query = LibraryQuery.ALL;
	private static @Nullable String selected;
	private static LibraryMeta.@Nullable Overlay overlay;
	/** Edits of user entries not yet seen in a reload (the in-memory sidecar is from the last reload). */
	private static final Map<String, LibraryMeta> EDITS = new HashMap<>();
	private static long cardsRevision = -1;
	private static int editCount;
	private static int cardsEdits = -1;
	private static List<LibraryCard> cards = List.of();
	private static @Nullable Palettes palettes;
	private static @Nullable String palettesKey;
	private static @Nullable VariantForm variantForm;
	private static boolean variantSending;
	private static @Nullable String variantError;
	private static @Nullable String lastVariantId;
	private static List<Exchange.Candidate> importList = List.of();
	private static @Nullable String importError;
	private static boolean importSending;
	private static @Nullable String lastImportId;
	private static @Nullable JsonObject lastExport;
	private static @Nullable String message;
	private static boolean messageError;
	/** Jobs seen running, so a snapshot that shows one finished (while offline) still reloads the library. */
	private static final Set<String> RUNNING = new HashSet<>();
	private static final Set<String> HANDLED = new HashSet<>();

	private LibraryFeature() {
	}

	public static void init() {
		Sidecar.state().addListener(new SidecarState.Listener() {
			@Override
			public void onVariant(@Nullable Variant previous, Variant v) {
				changed(previous, v);
			}
		});
	}

	// ------------------------------------------------------------------ cards

	/** {@code <gameDir>/architect/library-meta.json}, loaded lazily. */
	public static LibraryMeta.Overlay overlay() {
		if (overlay == null) {
			overlay = new LibraryMeta.Overlay(Blueprints.gameDataDir().resolve("library-meta.json")).load();
			if (overlay.loadError() != null) {
				Architect.LOGGER.warn("library-meta.json unreadable ({}); bundled entries show no user metadata until it is fixed", overlay.loadError());
			}
		}
		return overlay;
	}

	/** The metadata in force for an entry: the overlay for bundled ones, else a pending edit, else its sidecar. */
	public static LibraryMeta meta(Blueprints.Entry e) {
		String id = e.blueprint().id();
		if (e.bundled()) {
			return overlay().get(id);
		}
		LibraryMeta onDisk = LibraryMeta.read(e.json());
		LibraryMeta edit = EDITS.get(id);
		if (edit == null) {
			return onDisk;
		}
		if (edit.equals(onDisk)) {
			EDITS.remove(id); // the reload caught up
		}
		return edit;
	}

	/** Every entry as a card (cached until the library reloads or metadata changes). */
	public static List<LibraryCard> cards() {
		if (cardsRevision != Blueprints.revision() || cardsEdits != editCount) {
			if (cardsRevision != Blueprints.revision() && overlay != null) {
				overlay.load(); // picks up hand edits of the overlay on a reload
			}
			List<LibraryCard> out = new ArrayList<>();
			for (Blueprints.Entry e : Blueprints.entries()) {
				out.add(LibraryCard.of(e.blueprint(), e.json(), meta(e), e.bundled()));
			}
			cards = List.copyOf(out);
			cardsRevision = Blueprints.revision();
			cardsEdits = editCount;
		}
		return cards;
	}

	public static @Nullable LibraryCard card(@Nullable String id) {
		if (id == null) {
			return null;
		}
		for (LibraryCard c : cards()) {
			if (c.id().equals(id)) {
				return c;
			}
		}
		return null;
	}

	/** The cards that pass the filters, in the chosen order. */
	public static List<LibraryCard> visible() {
		return query.apply(cards());
	}

	/** A library id's shown name (for "variant of X"); the id when it is gone. */
	public static String nameOf(String id) {
		LibraryCard c = card(id);
		return c == null ? id : c.name();
	}

	public static LibraryQuery query() {
		return query;
	}

	public static void setQuery(LibraryQuery q) {
		query = q;
	}

	/** The selected entry; the first visible one when the selection is gone or filtered out. */
	public static @Nullable LibraryCard selected() {
		List<LibraryCard> v = visible();
		for (LibraryCard c : v) {
			if (c.id().equals(selected)) {
				return c;
			}
		}
		LibraryCard first = v.isEmpty() ? null : v.get(0);
		selected = first == null ? selected : first.id();
		return first;
	}

	public static void select(@Nullable String id) {
		selected = id;
	}

	public static @Nullable String message() {
		return message;
	}

	public static boolean messageError() {
		return messageError;
	}

	public static void say(@Nullable String m, boolean error) {
		message = m;
		messageError = error;
	}

	// ------------------------------------------------------------------ metadata

	/** Applies {@code edit} to an entry's user metadata and saves it (in place, or the overlay for bundled). Returns the new metadata. */
	public static LibraryMeta edit(String id, UnaryOperator<LibraryMeta> edit) throws IOException {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null) {
			throw new IOException("no library entry " + id);
		}
		LibraryMeta next;
		if (e.bundled()) {
			next = overlay().edit(id, edit);
		} else {
			Path sidecar = e.dir().resolve(id + Blueprints.SIDECAR_SUFFIX);
			next = LibraryMeta.editInPlace(sidecar, edit);
			EDITS.put(id, next);
		}
		editCount++;
		return next;
	}

	private static boolean tryEdit(String id, String done, UnaryOperator<LibraryMeta> edit) {
		try {
			edit(id, edit);
			say(done, false);
			return true;
		} catch (IOException | RuntimeException ex) {
			say("Could not save " + id + ": " + ex.getMessage(), true);
			Architect.LOGGER.warn("Library: saving the metadata of {} failed", id, ex);
			return false;
		}
	}

	public static boolean setFavorite(String id, boolean on) {
		return tryEdit(id, on ? "Starred " + nameOf(id) : "Unstarred " + nameOf(id), m -> m.withFavorite(on));
	}

	public static boolean rename(String id, @Nullable String name) {
		String n = name == null ? "" : name.strip();
		return tryEdit(id, n.isEmpty() ? "Name reset to the design's own" : "Renamed to " + n, m -> m.withDisplayName(n));
	}

	public static boolean setTags(String id, List<String> tags) {
		List<String> norm = LibraryMeta.normalizeTags(tags);
		return tryEdit(id, norm.isEmpty() ? "Tags cleared" : "Tags: " + String.join(", ", norm), m -> m.withTags(norm));
	}

	/** Moves a user entry to {@code architect/library-trash/} and reloads; bundled entries cannot be deleted. */
	public static CompletableFuture<Boolean> delete(String id) {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null || e.dir() == null) {
			say(e == null ? "No entry " + id : "A bundled design cannot be deleted", true);
			return CompletableFuture.completedFuture(false);
		}
		try {
			Path to = trash(e);
			EDITS.remove(id);
			say("Deleted " + nameOf(id) + " (kept in architect/library-trash/" + to.getFileName() + ")", false);
			if (id.equals(selected)) {
				selected = null;
			}
			return DesignFeature.reload(null);
		} catch (IOException ex) {
			say("Could not delete " + id + ": " + ex.getMessage(), true);
			return CompletableFuture.completedFuture(false);
		}
	}

	static Path trash(Blueprints.Entry e) throws IOException {
		Path trash = Blueprints.gameDataDir().resolve("library-trash");
		Files.createDirectories(trash);
		Path to = trash.resolve(e.blueprint().id() + "-" + System.currentTimeMillis());
		Files.move(e.dir(), to, StandardCopyOption.ATOMIC_MOVE);
		Architect.LOGGER.info("Library: moved {} to {}", e.dir(), to);
		return to;
	}

	// ------------------------------------------------------------------ export

	/**
	 * Export: {@code <gameDir>/architect/exports/<id>/} gets {@code <id>.nbt} and {@code <id>.blueprint.json} (with the user
	 * metadata), and the world gets {@code generated/architect_mc/structure/<id>.nbt}, which is then loaded back through the
	 * server's structure manager (as a structure block would load {@code architect_mc:<id>}) to prove it works. Completes
	 * on the client thread with what was written.
	 */
	public static CompletableFuture<JsonObject> export(String id) {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null) {
			return CompletableFuture.failedFuture(new IOException("no library entry " + id));
		}
		JsonObject sidecar = e.json().deepCopy();
		meta(e).applyTo(sidecar);
		Path dir = Exchange.exportDir(Blueprints.gameDataDir(), id);
		return ServerTasks.callOnServer(server -> {
			try {
				Files.createDirectories(dir);
				Path nbt = dir.resolve(id + ".nbt");
				Path src = e.dir() == null ? null : e.dir().resolve(id + ".nbt");
				if (src != null && Files.isRegularFile(src)) {
					Files.copy(src, nbt, StandardCopyOption.REPLACE_EXISTING);
				} else {
					StructureTemplateManager.save(nbt, e.template(), false);
				}
				LibraryMeta.writeAtomically(dir.resolve(id + Blueprints.SIDECAR_SUFFIX), LibraryMeta.pretty(sidecar));
				Path world = server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize();
				Path structure = Exchange.worldStructure(world, Exchange.NAMESPACE, id);
				StructureTemplateManager.save(structure, e.template(), false);
				Identifier sid = Identifier.fromNamespaceAndPath(Exchange.NAMESPACE, id);
				server.getStructureTemplateManager().remove(sid); // drop a cached older copy
				StructureTemplate loaded = server.getStructureTemplateManager().get(sid).orElse(null);
				JsonObject o = new JsonObject();
				o.addProperty("entry", id); // not "id": that is the DevBridge request id
				o.addProperty("dir", dir.toString());
				JsonArray files = new JsonArray();
				files.add(nbt.toString());
				files.add(dir.resolve(id + Blueprints.SIDECAR_SUFFIX).toString());
				o.add("files", files);
				o.addProperty("worldFile", structure.toString());
				o.addProperty("structureId", sid.toString());
				o.addProperty("structureLoads", loaded != null);
				if (loaded != null) {
					o.addProperty("structureSize", loaded.getSize().getX() + "x" + loaded.getSize().getY() + "x" + loaded.getSize().getZ());
				}
				return o;
			} catch (IOException ex) {
				throw new CompletionException(ex);
			}
		}).whenComplete((o, err) -> {
			if (err != null) {
				say("Export failed: " + cause(err).getMessage(), true);
			} else {
				lastExport = o;
				say("Exported to architect/exports/" + id + "/ and to this world as " + o.get("structureId").getAsString()
					+ (o.get("structureLoads").getAsBoolean() ? " (a structure block can load it)" : " (but it did not load back!)"),
					!o.get("structureLoads").getAsBoolean());
			}
		});
	}

	public static @Nullable JsonObject lastExport() {
		return lastExport;
	}

	// ------------------------------------------------------------------ import

	/** Rescans {@code architect/imports/} and the current world's structure-block saves. */
	public static List<Exchange.Candidate> refreshImports() {
		Minecraft mc = Minecraft.getInstance();
		Path world = mc.getSingleplayerServer() == null ? null : mc.getSingleplayerServer().getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize();
		try {
			Files.createDirectories(Exchange.importsDir(Blueprints.gameDataDir()));
			importList = Exchange.importCandidates(Blueprints.gameDataDir(), world);
			importError = null;
		} catch (IOException | RuntimeException ex) {
			importList = List.of();
			importError = "Could not list the files: " + ex.getMessage();
		}
		return importList;
	}

	public static List<Exchange.Candidate> importList() {
		return importList;
	}

	public static @Nullable String importError() {
		return importError;
	}

	public static boolean importSending() {
		return importSending;
	}

	public static @Nullable String lastImportId() {
		return lastImportId;
	}

	/** Sends {@code import.request {path}}; completes with the job id (or fails with why not). */
	public static CompletableFuture<String> importFile(Path file) {
		if (!Sidecar.connected()) {
			importError = "The design helper is not running (Status tab)";
			return CompletableFuture.failedFuture(new IOException(importError));
		}
		importSending = true;
		importError = null;
		return Sidecar.importRequest(file.toAbsolutePath().toString()).handle((ack, err) -> {
			importSending = false;
			String jobId = err == null && ack.ok() ? jobId(ack) : null;
			if (jobId == null) {
				importError = "Not imported: " + (err != null ? cause(err).getMessage() : ack.ok() ? "the helper sent no job id" : ack.error());
				throw new CompletionException(new IOException(importError));
			}
			lastImportId = jobId;
			RUNNING.add(jobId);
			say("Importing " + file.getFileName() + ": the Designs tab shows its progress", false);
			return jobId;
		});
	}

	// ------------------------------------------------------------------ variants

	/** The palettes for the Variants dialog: the sidecar's, else the jar's palettes.json, else the built-in list. */
	public static Palettes palettes() {
		JsonElement fromSidecar = Sidecar.state().palettes();
		String key = fromSidecar == null ? "jar" : "sidecar:" + fromSidecar.hashCode();
		if (palettes != null && key.equals(palettesKey)) {
			return palettes;
		}
		Palettes p = fromSidecar == null ? null : Palettes.parse(fromSidecar, "sidecar");
		if (p == null) {
			try (InputStream in = LibraryFeature.class.getResourceAsStream("/assets/" + Architect.MOD_ID + "/palettes.json")) {
				if (in != null) {
					p = Palettes.parse(JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)), "kit (bundled palettes.json)");
				}
			} catch (IOException | RuntimeException ex) {
				Architect.LOGGER.warn("palettes.json unreadable: {}", ex.getMessage());
			}
		}
		palettes = p == null ? Palettes.FALLBACK : p;
		palettesKey = key;
		return palettes;
	}

	/** Opens the Variants dialog's model for an entry. Throws when the entry cannot have variants. */
	public static VariantForm openVariants(String id) {
		LibraryCard c = card(id);
		if (c == null) {
			throw new IllegalArgumentException("no library entry " + id);
		}
		if (!c.canVariant()) {
			throw new IllegalArgumentException(c.imported() ? "an imported entry has no source to re-run" : "this entry has no parametric source");
		}
		variantForm = new VariantForm(id, c.params(), c.values(), c.palette(), palettes());
		variantError = null;
		return variantForm;
	}

	public static @Nullable VariantForm variantForm() {
		return variantForm;
	}

	public static void closeVariants() {
		variantForm = null;
		variantError = null;
	}

	public static boolean variantSending() {
		return variantSending;
	}

	public static @Nullable String variantError() {
		return variantError;
	}

	public static @Nullable String lastVariantId() {
		return lastVariantId;
	}

	/** "Make variant": sends {@code variant.request}; completes with the variant job id (or fails with why not). */
	public static CompletableFuture<String> submitVariant() {
		VariantForm f = variantForm;
		if (f == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("the Variants dialog is not open"));
		}
		if (!f.changed()) {
			variantError = "Change the palette or a parameter first";
			return CompletableFuture.failedFuture(new IllegalStateException(variantError));
		}
		if (!Sidecar.connected()) {
			variantError = "The design helper is not running (Status tab)";
			return CompletableFuture.failedFuture(new IllegalStateException(variantError));
		}
		variantSending = true;
		variantError = null;
		JsonObject payload = f.requestJson();
		return Sidecar.variantRequest(payload).handle((ack, err) -> {
			variantSending = false;
			String jobId = err == null && ack.ok() ? jobId(ack) : null;
			if (jobId == null) {
				variantError = "Not sent: " + (err != null ? cause(err).getMessage() : ack.ok() ? "the helper sent no variant id" : ack.error());
				throw new CompletionException(new IllegalStateException(variantError));
			}
			lastVariantId = jobId;
			RUNNING.add(jobId);
			Architect.LOGGER.info("Variant {} requested: {}", jobId, payload);
			say("Making a variant of " + nameOf(f.from()) + ": the Designs tab shows its progress", false);
			return jobId;
		});
	}

	private static @Nullable String jobId(SidecarLink.Ack ack) {
		JsonObject r = ack.result();
		if (r == null) {
			return null;
		}
		for (String k : List.of("variantId", "importId", "id")) {
			if (r.has(k) && r.get(k).isJsonPrimitive()) {
				return r.get(k).getAsString();
			}
		}
		return null;
	}

	private static Throwable cause(Throwable t) {
		return t instanceof CompletionException && t.getCause() != null ? t.getCause() : t;
	}

	private static void changed(@Nullable Variant previous, Variant v) {
		if (v.status().isRunning()) {
			RUNNING.add(v.id());
			return;
		}
		boolean wasRunning = previous == null ? RUNNING.contains(v.id()) : previous.status().isRunning();
		RUNNING.remove(v.id());
		if (!wasRunning || !HANDLED.add(v.id())) {
			return;
		}
		String key = Keys.screen == null ? "B" : Keys.label(Keys.screen);
		String what = title(v);
		switch (v.status()) {
			case DONE -> {
				Toasts.push(Toasts.Level.INFO, (v.isImport() ? "Imported: " : "Variant ready: ") + (v.name() != null ? v.name() : what),
					(v.blueprintId() == null ? v.id() : v.blueprintId()) + (v.size() == null ? "" : " (" + v.size()[0] + "×" + v.size()[1] + "×"
						+ v.size()[2] + ")") + ": in the Library.", key, "library");
				if (v.blueprintId() != null) {
					String bp = v.blueprintId();
					DesignFeature.reload(bp).thenAccept(ok -> {
						if (ok && selected == null) {
							selected = bp;
						}
					});
				}
			}
			case FAILED -> Toasts.push(Toasts.Level.WARN, (v.isImport() ? "Import failed: " : "Variant failed: ") + what,
				firstLine(v.error() != null ? v.error() : v.step()), key, "designs");
			default -> {
			}
		}
	}

	/** "Variant of Lakeside Cabin" / "Import of house.nbt". */
	public static String title(Variant v) {
		if (v.isImport()) {
			String p = v.path() == null ? "a structure" : Path.of(v.path()).getFileName().toString();
			return "Import of " + p;
		}
		return "Variant of " + (v.from() == null ? "?" : nameOf(v.from()));
	}

	private static String firstLine(String s) {
		String l = s.strip();
		int nl = l.indexOf('\n');
		l = nl >= 0 ? l.substring(0, nl) : l;
		return l.length() > 140 ? l.substring(0, 139) + "…" : l;
	}

	// ------------------------------------------------------------------ remix

	/**
	 * Remix…: fills the Design form from the entry's request, with {@code remix} = the entry and the notes empty (for "what
	 * to change"). A bundled entry has no request: its type, its size as a custom size, and its name are used.
	 */
	public static void prefillRemix(String id) {
		LibraryCard c = card(id);
		Blueprint b = Blueprints.get(id);
		if (c == null || b == null) {
			throw new IllegalArgumentException("no library entry " + id);
		}
		DesignFeature.resetForm();
		DesignForm f = DesignFeature.form();
		JsonObject r = c.request();
		String type = r != null && r.has("type") ? r.get("type").getAsString() : b.type();
		f.type = DesignSpec.find(DesignSpec.TYPES, type) != null ? type : DesignSpec.find(DesignSpec.TYPES, b.type()) != null ? b.type() : f.type;
		if (r != null && r.has("style") && r.get("style").isJsonPrimitive()) {
			String style = r.get("style").getAsString();
			if (DesignSpec.find(DesignSpec.STYLES, style) != null) {
				f.styleChip = style;
			} else {
				f.styleText.set(style);
			}
		}
		if (r != null && r.has("materials") && r.get("materials").isJsonPrimitive()) {
			f.materials.set(r.get("materials").getAsString());
		}
		f.features.clear();
		if (r != null && r.has("features") && r.get("features").isJsonArray()) {
			for (JsonElement e : r.getAsJsonArray("features")) {
				if (e.isJsonPrimitive() && f.features.size() < DesignSpec.MAX_FEATURES) {
					f.features.add(e.getAsString());
				}
			}
		}
		int[] size = {b.sizeX(), b.sizeY(), b.sizeZ()};
		if (r != null && r.has("maxSize") && r.get("maxSize").isJsonObject()) {
			JsonObject m = r.getAsJsonObject("maxSize");
			size = new int[] {m.get("x").getAsInt(), m.get("y").getAsInt(), m.get("z").getAsInt()};
		}
		f.customX = DesignSpec.clampXZ(Math.max(size[0], b.sizeX()));
		f.customY = DesignSpec.clampY(Math.max(size[1], b.sizeY()));
		f.customZ = DesignSpec.clampXZ(Math.max(size[2], b.sizeZ()));
		f.size = DesignForm.CUSTOM;
		String name = r != null && r.has("name") && r.get("name").isJsonPrimitive() ? r.get("name").getAsString() : c.name();
		f.name.set(name.length() > DesignSpec.MAX_NAME ? name.substring(0, DesignSpec.MAX_NAME) : name);
		f.notes.clear();
		f.remix = id;
		f.sendError = null;
	}

	// ------------------------------------------------------------------ DevBridge

	/** {@code dev.library.state}. */
	public static JsonObject stateJson() {
		JsonObject o = new JsonObject();
		JsonObject q = new JsonObject();
		q.addProperty("type", query.type());
		q.addProperty("tag", query.tag());
		q.addProperty("favorites", query.favoritesOnly());
		q.addProperty("text", query.text());
		q.addProperty("sort", query.sort().id());
		o.add("query", q);
		JsonArray all = new JsonArray();
		for (LibraryCard c : visible()) {
			all.add(cardJson(c, false));
		}
		o.add("cards", all);
		o.addProperty("total", cards().size());
		JsonArray types = new JsonArray();
		LibraryQuery.types(cards()).forEach(types::add);
		o.add("types", types);
		JsonArray tags = new JsonArray();
		LibraryQuery.userTags(cards()).forEach(tags::add);
		o.add("userTags", tags);
		LibraryCard s = selected();
		o.add("selected", s == null ? null : cardJson(s, true));
		o.addProperty("message", message);
		o.addProperty("messageError", messageError);
		o.addProperty("overlayFile", overlay().file().toString());
		o.addProperty("overlayError", overlay().loadError());
		o.add("variants", variantForm == null ? null : variantForm.stateJson());
		o.addProperty("variantSending", variantSending);
		o.addProperty("variantError", variantError);
		o.addProperty("lastVariantId", lastVariantId);
		JsonArray imports = new JsonArray();
		for (int i = 0; i < importList.size(); i++) {
			Exchange.Candidate c = importList.get(i);
			JsonObject j = new JsonObject();
			j.addProperty("index", i);
			j.addProperty("label", c.label());
			j.addProperty("where", c.where());
			j.addProperty("path", c.path().toString());
			j.addProperty("structureId", c.structureId());
			imports.add(j);
		}
		o.add("importList", imports);
		o.addProperty("importError", importError);
		o.addProperty("lastImportId", lastImportId);
		o.add("lastExport", lastExport);
		o.addProperty("revision", Blueprints.revision());
		return o;
	}

	public static JsonObject cardJson(LibraryCard c, boolean detail) {
		JsonObject j = new JsonObject();
		j.addProperty("id", c.id());
		j.addProperty("name", c.name());
		j.addProperty("type", c.type());
		j.addProperty("size", c.sizeX() + "x" + c.sizeY() + "x" + c.sizeZ());
		j.addProperty("favorite", c.favorite());
		JsonArray ut = new JsonArray();
		c.userTags().forEach(ut::add);
		j.add("userTags", ut);
		j.addProperty("badge", c.badge());
		j.addProperty("bundled", c.bundled());
		j.addProperty("canVariant", c.canVariant());
		if (detail) {
			j.addProperty("baseName", c.baseName());
			j.addProperty("description", c.description());
			j.addProperty("provenance", c.provenance(LibraryFeature::nameOf));
			j.addProperty("variantOf", c.variantOf());
			j.addProperty("imported", c.imported());
			j.addProperty("hasRequest", c.request() != null);
			j.add("palette", c.palette());
			j.add("values", c.values());
			j.add("params", c.params());
			JsonArray m = new JsonArray();
			c.materials().forEach(m::add);
			j.add("materials", m);
		}
		return j;
	}
}
