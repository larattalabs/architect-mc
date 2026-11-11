package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Designs;
import dev.larattalabs.architect.api.Library;
import net.minecraft.commands.CommandSourceStack;

/**
 * The slice 6d FS steps of apitest (docs/CONTRACT.md "Phase 6d slice FS"): Library.followers, Designs.follow and Designs.followAll,
 * through {@code dev.larattalabs.architect.api} only.
 */
public final class ApiTestFS {
	private ApiTestFS() {
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		switch (a[0]) {
			case "followers": {
				// followers <sourceEntryId>
				JsonArray out = new JsonArray();
				for (Library.Follower f : api.library().followers(a[1])) {
					JsonObject o = new JsonObject();
					o.addProperty("entryId", f.entryId());
					o.addProperty("kind", f.kind().name());
					o.addProperty("sourceVersion", f.sourceVersion());
					o.addProperty("headVersion", f.headVersion());
					o.addProperty("sourceHead", f.sourceHead());
					o.addProperty("behind", f.behind());
					out.add(o);
				}
				return out;
			}
			case "follow": {
				// follow <key> <copyEntryId> <toSourceVersion> <opKey|->
				return ApiTest.later("follow:" + a[1], api.designs().follow(a[2], Integer.parseInt(a[3]), a[4].equals("-") ? null : a[4]).thenApply(ApiTestFS::json));
			}
			case "followall": {
				// followall <key> <sourceEntryId> <toSourceVersion> <opKey|->
				return ApiTest.later("followall:" + a[1], api.designs().followAll(a[2], Integer.parseInt(a[3]), a[4].equals("-") ? null : a[4]).thenApply(rs -> {
					JsonArray out = new JsonArray();
					rs.forEach(r -> out.add(json(r)));
					return out;
				}));
			}
			case "apifs": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				o.addProperty("followSource", api.features().contains("followSource"));
				return o;
			}
			default:
				return new JsonPrimitive("unknown step " + a[0]);
		}
	}

	static JsonObject json(Designs.FollowResult r) {
		JsonObject o = new JsonObject();
		o.addProperty("entryId", r.entryId());
		o.addProperty("followed", r.followed());
		o.addProperty("fromVersion", r.fromVersion());
		o.addProperty("newVersion", r.newVersion());
		o.addProperty("sourceVersion", r.sourceVersion());
		o.addProperty("refused", r.refused());
		o.addProperty("alreadyFollowed", r.alreadyFollowed());
		o.addProperty("message", r.message());
		return o;
	}
}
