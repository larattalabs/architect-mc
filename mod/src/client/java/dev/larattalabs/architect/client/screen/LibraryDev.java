package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.dev.Fields;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.library.Exchange;
import dev.larattalabs.architect.library.LibraryCard;
import dev.larattalabs.architect.library.LibraryQuery;
import dev.larattalabs.architect.library.VariantForm;
import dev.larattalabs.architect.placement.Blueprints;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import net.minecraft.client.Minecraft;

/**
 * DevBridge hooks for the library (docs/CONTRACT.md "Phase 2 gate", driven headlessly): {@code dev.library.*}. Each opens
 * the Architect screen on the Library tab and goes through the same code the controls do (the inline Rename / Tags
 * editor, the Variants… and Import… dialogs), so a screenshot right after shows the result. {@code entry} defaults to the
 * selected card.
 */
final class LibraryDev {
	private LibraryDev() {
	}

	private static ArchitectScreen library(Minecraft mc) {
		if (mc.player == null) {
			throw new DevBridge.DevException("not in a world");
		}
		ArchitectScreen s = mc.gui.screen() instanceof ArchitectScreen a ? a : ArchitectScreen.open(ArchitectScreen.Tab.LIBRARY);
		if (s.tab() != ArchitectScreen.Tab.LIBRARY) {
			s.setTab(ArchitectScreen.Tab.LIBRARY);
		}
		s.showDesigns();
		return s;
	}

	private static LibraryCard entry(Fields f) {
		String id = f.optStr("entry", null);
		LibraryCard c = id == null ? LibraryFeature.selected() : LibraryFeature.card(id);
		if (c == null) {
			throw new DevBridge.DevException(id == null ? "no entry selected (pass entry)" : "no library entry '" + id + "'");
		}
		LibraryFeature.select(c.id());
		return c;
	}

	private static JsonObject state(Minecraft mc) {
		JsonObject o = LibraryFeature.stateJson();
		if (mc.gui.screen() instanceof ArchitectScreen s) {
			o.addProperty("screenTab", s.tab().id());
			o.addProperty("dialog", LibraryTab.dialog.name().toLowerCase(java.util.Locale.ROOT));
			o.addProperty("edit", s.library().edit.name().toLowerCase(java.util.Locale.ROOT));
			o.addProperty("focus", s.focusName());
		}
		return o;
	}

	private static Throwable cause(Throwable t) {
		return t instanceof CompletionException && t.getCause() != null ? t.getCause() : t;
	}

	static void register() {
		DevBridge.register("dev.library.state", 10_000, "{} - the library: query, visible cards, selected (detail), user tags, the Variants "
			+ "form, the import list, the last export, messages", (req, mc) -> DevBridge.onClient(mc, () -> state(mc)));
		DevBridge.register("dev.library.filter", 10_000, "{reset?, buildingType? (all|<type>), tag? (all|<tag>), favorites?, text?, sort?: "
			+ "newest|name|size, collection?: all|bible:<id>|group:<id>} - set the Library tab's search/filters/sort and the Collection filter",
			(req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					ArchitectScreen s = library(mc);
					LibraryQuery q = f.optBool("reset", false) ? LibraryQuery.ALL : LibraryFeature.query();
					if (f.has("buildingType")) {
						String t = f.str("buildingType");
						q = q.withType("all".equals(t) ? null : t);
					}
					if (f.has("tag")) {
						String t = f.str("tag");
						q = q.withTag("all".equals(t) ? null : t);
					}
					if (f.has("favorites")) {
						q = q.withFavoritesOnly(f.bool("favorites"));
					}
					if (f.has("collection")) {
						String c = f.isExplicitNull("collection") ? null : f.str("collection");
						q = q.withCollection(c == null || "all".equals(c) ? null : c);
					}
					if (f.has("sort")) {
						LibraryQuery.Sort so = LibraryQuery.Sort.of(f.str("sort"));
						if (so == null) {
							throw new DevBridge.DevException("sort must be newest, name or size");
						}
						q = q.withSort(so);
					}
					if (f.has("text") || f.optBool("reset", false)) {
						String t = f.optStr("text", "");
						q = q.withText(t);
						s.library().search.set(t);
					}
					LibraryFeature.setQuery(q);
					s.resetScroll();
					return state(mc);
				});
			});
		DevBridge.register("dev.library.select", 10_000, "{entry} - select a card", (req, mc) -> {
			Fields f = Fields.of(req);
			return DevBridge.onClient(mc, () -> {
				library(mc);
				entry(f);
				return state(mc);
			});
		});
		DevBridge.register("dev.library.favorite", 10_000, "{entry?, on? (default: toggle)} - the star", (req, mc) -> {
			Fields f = Fields.of(req);
			return DevBridge.onClient(mc, () -> {
				library(mc);
				LibraryCard c = entry(f);
				Boolean on = f.optBool("on");
				if (!LibraryFeature.setFavorite(c.id(), on == null ? !c.favorite() : on)) {
					throw new DevBridge.DevException(LibraryFeature.message());
				}
				return state(mc);
			});
		});
		DevBridge.register("dev.library.rename", 10_000, "{entry?, name} - Rename (the inline editor; \"\" = back to the design's own name)",
			(req, mc) -> {
				Fields f = Fields.of(req);
				String name = f.str("name");
				return DevBridge.onClient(mc, () -> {
					ArchitectScreen s = library(mc);
					LibraryCard c = entry(f);
					s.library().startEdit(LibraryTab.Edit.RENAME, c);
					s.library().rename.set(name);
					s.library().commitEdit();
					if (LibraryFeature.messageError()) {
						throw new DevBridge.DevException(LibraryFeature.message());
					}
					return state(mc);
				});
			});
		DevBridge.register("dev.library.tag", 10_000, "{entry?, tags: [..] | \"a, b\"} - Tags (the inline editor; replaces the user tags)",
			(req, mc) -> {
				Fields f = Fields.of(req);
				JsonElement t = f.json().get("tags");
				if (t == null) {
					throw new DevBridge.DevException("field 'tags' is required");
				}
				String typed;
				if (t.isJsonArray()) {
					StringBuilder b = new StringBuilder();
					for (JsonElement e : t.getAsJsonArray()) {
						b.append(b.isEmpty() ? "" : ", ").append(e.getAsString());
					}
					typed = b.toString();
				} else {
					typed = t.getAsString();
				}
				return DevBridge.onClient(mc, () -> {
					ArchitectScreen s = library(mc);
					LibraryCard c = entry(f);
					s.library().startEdit(LibraryTab.Edit.TAGS, c);
					s.library().tags.set(typed);
					s.library().commitEdit();
					if (LibraryFeature.messageError()) {
						throw new DevBridge.DevException(LibraryFeature.message());
					}
					return state(mc);
				});
			});
		DevBridge.register("dev.library.delete", 20_000, "{entry?} - Delete (to architect/library-trash; bundled entries refuse) and reload",
			(req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					library(mc);
					LibraryCard c = entry(f);
					return LibraryFeature.delete(c.id()).thenCompose(ok -> DevBridge.onClient(mc, () -> {
						if (!ok) {
							throw new DevBridge.DevException(LibraryFeature.message());
						}
						return state(mc);
					}));
				}).thenCompose(x -> x);
			});
		DevBridge.register("dev.library.export", 30_000, "{entry?} - Export: architect/exports/<id>/ + the world's generated/architect_mc/structure/"
			+ "<id>.nbt -> {dir, files, worldFile, structureId, structureLoads, structureSize}", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					library(mc);
					return LibraryFeature.export(entry(f).id());
				}).thenCompose(x -> x).exceptionally(err -> {
					throw new DevBridge.DevException("export failed: " + cause(err).getMessage());
				});
			});
		DevBridge.register("dev.library.import.list", 10_000, "{} - Import…: opens the dialog and lists the .nbt files (imports/ and this world's "
			+ "structure-block saves)", (req, mc) -> DevBridge.onClient(mc, () -> {
				ArchitectScreen s = library(mc);
				s.library().openImport();
				return state(mc);
			}));
		DevBridge.register("dev.library.import.pick", 20_000, "{index? | path?} - pick a file in the Import… list and press Import "
			+ "(import.request) -> {jobId}", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					ArchitectScreen s = library(mc);
					if (LibraryTab.dialog != LibraryTab.Dialog.IMPORT) {
						s.library().openImport();
					}
					List<Exchange.Candidate> l = LibraryFeature.importList();
					int index = -1;
					if (f.has("path")) {
						Path want = Path.of(f.str("path")).toAbsolutePath().normalize();
						for (int i = 0; i < l.size(); i++) {
							if (l.get(i).path().toAbsolutePath().normalize().equals(want)) {
								index = i;
							}
						}
						if (index < 0) {
							throw new DevBridge.DevException("not in the import list: " + want);
						}
					} else {
						index = f.optInt("index", 0, 0, Math.max(0, l.size() - 1));
					}
					if (l.isEmpty()) {
						throw new DevBridge.DevException("the import list is empty");
					}
					LibraryTab.importSel = index;
					return LibraryFeature.importFile(l.get(index).path()).thenApply(id -> {
						LibraryTab.dialog = LibraryTab.Dialog.NONE;
						s.showJob(id);
						JsonObject o = state(mc);
						o.addProperty("jobId", id);
						return o;
					});
				}).thenCompose(x -> x).exceptionally(err -> {
					throw new DevBridge.DevException(cause(err).getMessage());
				});
			});
		DevBridge.register("dev.library.variants.open", 10_000, "{entry?} - Variants… (refused for imported entries and entries without a source)",
			(req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					ArchitectScreen s = library(mc);
					LibraryCard c = entry(f);
					if (!c.canVariant()) {
						throw new DevBridge.DevException("Variants… is disabled for " + c.id() + (c.imported() ? " (imported)" : " (no source)"));
					}
					s.library().openVariants(c.id());
					return state(mc);
				});
			});
		DevBridge.register("dev.library.variants.set", 10_000, "{preset?, wood?, stone?, roof?, accent?, bible?: id|null (a re-skin), values?: "
			+ "{param: value}, steps?: {param: delta}, toggle?: [param], name?} - change the open Variants dialog", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					ArchitectScreen s = library(mc);
					VariantForm form = LibraryFeature.variantForm();
					if (form == null || LibraryTab.dialog != LibraryTab.Dialog.VARIANTS) {
						throw new DevBridge.DevException("the Variants dialog is not open (dev.library.variants.open)");
					}
					try {
						if (f.has("preset")) {
							form.choosePreset(f.str("preset"));
						}
						for (String field : dev.larattalabs.architect.library.Palettes.FIELDS) {
							if (f.has(field)) {
								form.setField(field, f.str(field));
							}
						}
						if (f.has("bible")) {
							form.chooseBible(f.isExplicitNull("bible") ? null : f.str("bible"));
						}
						if (f.has("values")) {
							for (var e : f.json().getAsJsonObject("values").entrySet()) {
								form.set(e.getKey(), e.getValue());
							}
						}
						if (f.has("steps")) {
							for (var e : f.json().getAsJsonObject("steps").entrySet()) {
								form.step(e.getKey(), e.getValue().getAsInt());
							}
						}
						if (f.has("toggle")) {
							for (JsonElement e : f.json().getAsJsonArray("toggle")) {
								form.toggle(e.getAsString());
							}
						}
						if (f.has("name")) {
							s.library().variantName.set(f.str("name"));
							form.setName(f.str("name"));
						}
					} catch (IllegalArgumentException ex) {
						throw new DevBridge.DevException(ex.getMessage());
					}
					return state(mc);
				});
			});
		DevBridge.register("dev.library.variants.submit", 20_000, "{} - Make variant (variant.request) -> {jobId}", (req, mc) -> DevBridge.onClient(mc,
			() -> {
				ArchitectScreen s = library(mc);
				if (LibraryTab.dialog != LibraryTab.Dialog.VARIANTS) {
					throw new DevBridge.DevException("the Variants dialog is not open");
				}
				return LibraryFeature.submitVariant().thenApply(id -> {
					LibraryTab.dialog = LibraryTab.Dialog.NONE;
					LibraryFeature.closeVariants();
					s.showJob(id);
					JsonObject o = state(mc);
					o.addProperty("jobId", id);
					return o;
				});
			}).thenCompose(x -> x).exceptionally(err -> {
				throw new DevBridge.DevException(cause(err).getMessage());
			}));
		DevBridge.register("dev.library.remix", 10_000, "{entry?} - Remix…: the Design tab prefilled from the entry, remix set, notes focused",
			(req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					ArchitectScreen s = library(mc);
					s.remix(entry(f).id());
					JsonObject o = DesignFeature.form().stateJson();
					o.addProperty("screenTab", s.tab().id());
					o.addProperty("focus", s.focusName());
					return o;
				});
			});
		DevBridge.register("dev.library.wait", req -> Fields.of(req).optLong("timeoutMs", 60_000, 1_000, 600_000) + 5_000,
			"{jobId, timeoutMs?: 60000} - wait until a variant/import job is done (and its entry loaded) or failed -> {status, blueprintId, error}",
			(req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("jobId");
				long deadline = System.currentTimeMillis() + f.optLong("timeoutMs", 60_000, 1_000, 600_000);
				CompletableFuture<JsonObject> out = new CompletableFuture<>();
				poll(mc, id, deadline, out);
				return out;
			});
	}

	private static void poll(Minecraft mc, String id, long deadline, CompletableFuture<JsonObject> out) {
		mc.execute(() -> {
			SidecarState.Variant v = Sidecar.state().variant(id);
			boolean finished = v != null && !v.status().isRunning() && (v.status() != SidecarState.VariantStatus.DONE || v.blueprintId() == null
				|| Blueprints.get(v.blueprintId()) != null);
			if (finished) {
				JsonObject o = new JsonObject();
				o.addProperty("status", v.status().wire());
				o.addProperty("blueprintId", v.blueprintId());
				o.addProperty("error", v.error());
				o.add("variant", v.raw());
				out.complete(o);
				return;
			}
			if (System.currentTimeMillis() > deadline) {
				out.completeExceptionally(new DevBridge.DevException("job " + id + " not finished: " + (v == null ? "unknown" : v.status().wire() + " " + v
					.step())));
				return;
			}
			CompletableFuture.delayedExecutor(250, TimeUnit.MILLISECONDS).execute(() -> poll(mc, id, deadline, out));
		});
	}
}
