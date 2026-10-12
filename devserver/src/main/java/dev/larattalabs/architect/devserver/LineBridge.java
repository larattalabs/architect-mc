package dev.larattalabs.architect.devserver;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.devserver.gen.DevBridge;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;

/**
 * The headless DevBridge's transport inside the server JVM: loopback TCP, one JSON object per line, for
 * tools/run-headless-server.mjs only (it serves the DevBridge's WebSocket protocol to the gate drivers and forwards here).
 * The first line of a connection must be {@code {"token": "<ARCHITECT_DEV_TOKEN>"}}; then each line is a DevBridge request
 * and each reply a line, in completion order (match them by id). The port is ARCHITECT_DEVSERVER_PORT (0: any free port),
 * written to ARCHITECT_DEVSERVER_PORT_FILE once listening.
 */
final class LineBridge {
	private LineBridge() {
	}

	static void start(int port, String token, Path portFile) throws IOException {
		ServerSocket ss = new ServerSocket(port, 8, InetAddress.getLoopbackAddress());
		if (portFile != null) {
			Files.createDirectories(portFile.toAbsolutePath().getParent());
			Files.writeString(portFile, Integer.toString(ss.getLocalPort()), StandardCharsets.UTF_8);
		}
		Architect.LOGGER.info("devserver: line bridge listening on 127.0.0.1:{}", ss.getLocalPort());
		Thread t = new Thread(() -> {
			while (!ss.isClosed()) {
				try {
					Socket s = ss.accept();
					Thread c = new Thread(() -> serve(s, token), "devserver-bridge-conn");
					c.setDaemon(true);
					c.start();
				} catch (IOException e) {
					if (!ss.isClosed()) {
						Architect.LOGGER.warn("devserver: accept failed: {}", e.toString());
					}
				}
			}
		}, "devserver-bridge");
		t.setDaemon(true);
		t.start();
	}

	private static void serve(Socket s, String token) {
		try (s; BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8))) {
			s.setTcpNoDelay(true);
			OutputStream out = s.getOutputStream();
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

	private static void write(OutputStream out, String json) throws IOException {
		byte[] b = (json.replace("\n", "\\n") + "\n").getBytes(StandardCharsets.UTF_8);
		synchronized (out) {
			out.write(b);
			out.flush();
		}
	}
}
