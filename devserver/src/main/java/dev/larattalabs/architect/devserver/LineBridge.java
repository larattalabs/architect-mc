package dev.larattalabs.architect.devserver;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.devserver.gen.DevBridge;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;

/**
 * The headless DevBridge's transport inside the server JVM: a Unix socket, one JSON object per line, for
 * tools/run-headless-server.mjs only (it serves the DevBridge's WebSocket protocol to the gate drivers and forwards here).
 * The first line of a connection must be {@code {"token": "<ARCHITECT_DEV_TOKEN>"}}; then each line is a DevBridge request
 * and each reply a line, in completion order (match them by id). The socket is ARCHITECT_DEVSERVER_SOCKET.
 */
final class LineBridge {
	private LineBridge() {
	}

	/** Listens on the Unix socket {@code socketPath} (replacing a stale one), so a headless server binds no extra TCP port. */
	static void start(Path socketPath, String token) throws IOException {
		Files.deleteIfExists(socketPath);
		ServerSocketChannel ss = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
		ss.bind(UnixDomainSocketAddress.of(socketPath));
		Architect.LOGGER.info("devserver: line bridge listening on {}", socketPath);
		Thread t = new Thread(() -> {
			while (ss.isOpen()) {
				try {
					SocketChannel s = ss.accept();
					Thread c = new Thread(() -> serve(s, token), "devserver-bridge-conn");
					c.setDaemon(true);
					c.start();
				} catch (IOException e) {
					if (ss.isOpen()) {
						Architect.LOGGER.warn("devserver: accept failed: {}", e.toString());
					}
				}
			}
		}, "devserver-bridge");
		t.setDaemon(true);
		t.start();
	}

	private static void serve(SocketChannel s, String token) {
		try (s; BufferedReader in = new BufferedReader(new InputStreamReader(Channels.newInputStream(s), StandardCharsets.UTF_8))) {
			// replies are written on the channel itself (a reader and a writer may run at once on a SocketChannel; a
			// Channels.newOutputStream would wait for the pending read)
			SocketChannel out = s;
			String first = in.readLine();
			String presented = null;
			try {
				JsonObject hello = JsonParser.parseString(first == null ? "" : first).getAsJsonObject();
				presented = hello.has("token") ? hello.get("token").getAsString() : null;
			} catch (RuntimeException e) {
				// refused below
			}
			if (presented == null || !MessageDigest.isEqual(presented.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8))) {
				write(out, "{\"type\":\"dev.hello\",\"ok\":false,\"error\":\"token invalid\"}");
				return;
			}
			JsonObject hello = new JsonObject();
			hello.addProperty("type", "dev.hello");
			hello.addProperty("ok", true);
			hello.addProperty("protocol", DevBridge.PROTOCOL);
			hello.addProperty("mod", Architect.MOD_ID);
			hello.addProperty("minecraft", net.minecraft.SharedConstants.getCurrentVersion().name());
			hello.addProperty("headless", true);
			write(out, DevBridge.GSON.toJson(hello));
			String line;
			while ((line = in.readLine()) != null) {
				JsonObject req;
				try {
					req = JsonParser.parseString(line).getAsJsonObject();
				} catch (RuntimeException e) {
					write(out, "{\"ok\":false,\"error\":\"invalid JSON\"}");
					continue;
				}
				DevBridge.dispatch(req).thenAccept(reply -> {
					try {
						write(out, DevBridge.GSON.toJson(reply));
					} catch (IOException e) {
						// the supervisor went away
					}
				});
			}
		} catch (IOException e) {
			// connection closed
		}
	}

	private static void write(SocketChannel out, String json) throws IOException {
		java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap((json.replace("\n", "\\n") + "\n").getBytes(StandardCharsets.UTF_8));
		synchronized (out) {
			while (b.hasRemaining()) {
				out.write(b);
			}
		}
	}
}
