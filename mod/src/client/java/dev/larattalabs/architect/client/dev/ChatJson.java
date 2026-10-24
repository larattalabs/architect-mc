package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Optional;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import org.jspecify.annotations.Nullable;

/**
 * A chat component as JSON for the DevBridge (UI-2b): its plain text and each styled part's text, click action and command, so a
 * gate can prove a line's links ([Undo], [next ›]) and not only its words.
 */
public final class ChatJson {
	private ChatJson() {
	}

	public static @Nullable JsonObject of(@Nullable Component c) {
		if (c == null) {
			return null;
		}
		JsonObject o = new JsonObject();
		o.addProperty("text", c.getString());
		JsonArray parts = new JsonArray();
		JsonArray links = new JsonArray();
		c.visit((Style st, String text) -> {
			JsonObject p = new JsonObject();
			p.addProperty("text", text);
			ClickEvent click = st.getClickEvent();
			if (click != null) {
				String action = switch (click) {
					case ClickEvent.RunCommand r -> "run_command";
					case ClickEvent.SuggestCommand s -> "suggest_command";
					case ClickEvent.CopyToClipboard s -> "copy_to_clipboard";
					case ClickEvent.OpenFile f -> "open_file";
					default -> click.action().getSerializedName();
				};
				String value = switch (click) {
					case ClickEvent.RunCommand r -> r.command();
					case ClickEvent.SuggestCommand s -> s.command();
					case ClickEvent.CopyToClipboard s -> s.value();
					default -> click.toString();
				};
				p.addProperty("click", action);
				p.addProperty("value", value);
				JsonObject l = new JsonObject();
				l.addProperty("text", text);
				l.addProperty("click", action);
				l.addProperty("value", value);
				links.add(l);
			}
			if (st.getHoverEvent() != null) {
				p.addProperty("hover", true);
			}
			parts.add(p);
			return Optional.empty();
		}, Style.EMPTY);
		o.add("parts", parts);
		o.add("links", links);
		return o;
	}
}
