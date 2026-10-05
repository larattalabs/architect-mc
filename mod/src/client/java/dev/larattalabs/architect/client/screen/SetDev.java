package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.dev.Fields;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import java.util.concurrent.CompletionException;
import net.minecraft.client.Minecraft;

/**
 * DevBridge hooks for the phase 4b UI (docs/DEVBRIDGE.md): the Design tab's "Design a set…" dialog (open, fill, draft a bible,
 * submit, state), the Library's collection re-skin and the Designs tab's set actions. Client thread.
 */
final class SetDev {
	private SetDev() {
	}

	private static ArchitectScreen screen(Minecraft mc, ArchitectScreen.Tab tab) {
		if (mc.player == null) {
			throw new DevBridge.DevException("not in a world");
		}
		ArchitectScreen s = mc.gui.screen() instanceof ArchitectScreen a ? a : ArchitectScreen.open(tab);
		if (s.tab() != tab) {
			s.setTab(tab);
		}
		return s;
	}

	private static JsonObject state(Minecraft mc) {
		JsonObject o = SetFeature.stateJson();
		if (mc.gui.screen() instanceof ArchitectScreen s) {
			o.add("screen", s.stateJson());
		}
		return o;
	}

	private static Throwable cause(Throwable t) {
		return t instanceof CompletionException && t.getCause() != null ? t.getCause() : t;
	}

	static void register() {
		DevBridge.register("dev.set.state", 10_000, "{} - the Design a set… dialog: fields, errors, the live estimate, the request as it would be sent",
			(req, mc) -> DevBridge.onClient(mc, () -> state(mc)));
		DevBridge.register("dev.set.open", 10_000, "{} - Design tab, Design a set…", (req, mc) -> DevBridge.onClient(mc, () -> {
			screen(mc, ArchitectScreen.Tab.DESIGN).openSet();
			return state(mc);
		}));
		DevBridge.register("dev.set.close", 10_000, "{} - Cancel the Design a set… dialog", (req, mc) -> DevBridge.onClient(mc, () -> {
			screen(mc, ArchitectScreen.Tab.DESIGN).closeSet();
			return state(mc);
		}));
		DevBridge.register("dev.set.fill", 10_000, "{name?, bible?: id | \"new\", prompt?, items?: [{type, name?, role?: landmark|ordinary, notes?}], "
			+ "concurrency?, budgetUsd?: number|null} - set the open dialog's fields (items replace the rows)", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					SetFeature.Form form = SetFeature.form();
					if (form == null) {
						throw new DevBridge.DevException("the Design a set… dialog is not open (dev.set.open)");
					}
					if (f.has("name")) {
						form.name.set(f.str("name"));
					}
					if (f.has("bible")) {
						String b = f.str("bible");
						form.newBible = "new".equals(b);
						form.bible = form.newBible ? null : b;
					}
					if (f.has("prompt")) {
						form.prompt.set(f.str("prompt"));
					}
					if (f.has("items")) {
						form.items.clear();
						for (JsonElement e : f.json().getAsJsonArray("items")) {
							JsonObject i = e.getAsJsonObject();
							form.addItem();
							SetFeature.Item it = form.items.get(form.items.size() - 1);
							it.type.set(i.has("type") ? i.get("type").getAsString() : "house");
							it.name.set(i.has("name") ? i.get("name").getAsString() : "");
							it.landmark = i.has("role") && "landmark".equals(i.get("role").getAsString());
							it.notes.set(i.has("notes") ? i.get("notes").getAsString() : "");
						}
					}
					if (f.has("concurrency")) {
						form.concurrency = f.optInt("concurrency", 3, 1, 6);
					}
					if (f.has("budgetUsd")) {
						form.budgetUsd = f.isExplicitNull("budgetUsd") ? null : f.num("budgetUsd", 0.01, 1000);
					}
					form.sendError = null;
					return state(mc);
				});
			});
		DevBridge.register("dev.set.draft", 20_000, "{} - Draft bible (bible.request with the prompt) -> {jobId}", (req, mc) -> DevBridge.onClient(mc,
			() -> SetFeature.draftBible().handle((id, err) -> {
				JsonObject o = state(mc);
				o.addProperty("jobId", id);
				o.addProperty("error", err == null ? null : cause(err).getMessage());
				return o;
			})).thenCompose(x -> x));
		DevBridge.register("dev.set.submit", 30_000, "{} - Design the set (design.group) -> {groupId}; the screen shows it in the Designs tab",
			(req, mc) -> DevBridge.onClient(mc, () -> {
				ArchitectScreen s = screen(mc, ArchitectScreen.Tab.DESIGN);
				if (SetFeature.form() == null) {
					throw new DevBridge.DevException("the Design a set… dialog is not open (dev.set.open)");
				}
				return SetFeature.submit().handle((id, err) -> {
					if (id != null) {
						s.showJob(id);
					}
					JsonObject o = state(mc);
					o.addProperty("groupId", id);
					o.addProperty("error", err == null ? null : cause(err).getMessage());
					return o;
				});
			}).thenCompose(x -> x));
		DevBridge.register("dev.library.reskin", 20_000, "{collection?: bible:<id>|group:<id> (default: the Collection filter), bible} - Re-skin "
			+ "collection… -> {reskinId}", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					screen(mc, ArchitectScreen.Tab.LIBRARY);
					String key = f.has("collection") ? f.str("collection") : LibraryFeature.query().collection();
					if (key == null) {
						throw new DevBridge.DevException("no collection: pass one or set the Collection filter (dev.library.filter {collection})");
					}
					return SetFeature.reskin(key, f.nonBlank("bible")).handle((id, err) -> {
						JsonObject o = new JsonObject();
						o.addProperty("reskinId", id);
						o.addProperty("error", err == null ? null : cause(err).getMessage());
						o.addProperty("message", SetFeature.message());
						return o;
					});
				}).thenCompose(x -> x);
			});
		DevBridge.register("dev.group.action", 20_000, "{group, action: cancel|resume|extend, budgetUsd? (extend)} - the Designs tab's set buttons",
			(req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("group");
				String action = f.nonBlank("action");
				return DevBridge.onClient(mc, () -> (switch (action) {
					case "cancel" -> SetFeature.cancelGroup(id);
					case "resume" -> SetFeature.resumeGroup(id);
					case "extend" -> SetFeature.extendGroup(id, f.num("budgetUsd", 0.01, 1000));
					default -> throw new DevBridge.DevException("action must be cancel, resume or extend");
				}).thenApply(ack -> {
					JsonObject o = new JsonObject();
					o.addProperty("ok", ack.ok());
					o.addProperty("error", ack.error());
					o.addProperty("message", SetFeature.message());
					return o;
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.bibles", 10_000, "{} - the bibles the UI lists (installed + built in) and the bible jobs", (req, mc) -> DevBridge.onClient(mc,
			() -> {
				JsonObject o = new JsonObject();
				JsonArray a = new JsonArray();
				for (var b : SetFeature.bibles()) {
					JsonObject j = new JsonObject();
					j.addProperty("id", b.id());
					j.addProperty("name", b.name());
					j.addProperty("version", b.version());
					j.addProperty("builtin", b.builtin());
					j.addProperty("roles", b.roles().size());
					j.addProperty("sheetPath", b.sheetPath().map(Object::toString).orElse(null));
					a.add(j);
				}
				o.add("bibles", a);
				o.add("bibleJobs", Sidecar.state().json().get("bibleJobs"));
				return o;
			}));
	}
}
