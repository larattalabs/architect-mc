import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.zip.GZIPOutputStream;

/**
 * 6c SCH gate, item 2 on Linux (tools/gate6csch.mjs `linux`): gzips each raw (uncompressed) schematic NBT in a folder exactly as
 * the mod's {@code Schematic.gzip} does (GZIPOutputStream, deflate level 9) and prints "name sha256 bytes". Run in a Linux
 * container with the same JDK as CI (eclipse-temurin:25): the same sha256 as the macOS export proves the bytes match.
 */
public class SchemGzip {
	public static void main(String[] args) throws Exception {
		File[] files = new File(args[0]).listFiles((d, n) -> n.endsWith(".raw"));
		java.util.Arrays.sort(files);
		for (File f : files) {
			ByteArrayOutputStream bo = new ByteArrayOutputStream();
			try (GZIPOutputStream gz = new GZIPOutputStream(bo) {
				{
					def.setLevel(9);
				}
			}) {
				gz.write(Files.readAllBytes(f.toPath()));
			}
			byte[] b = bo.toByteArray();
			System.out.println(f.getName().replace(".raw", "") + " " + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b)) + " "
				+ b.length);
		}
		System.out.println("jvm " + System.getProperty("java.vm.vendor") + " " + System.getProperty("java.version") + " " + System.getProperty("os.name")
			+ " " + System.getProperty("os.arch"));
	}
}
