package dev.larattalabs.architect.mixin;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/**
 * (SS) RegionFileFlushMixin skips the force of a region file with nothing written since its last force, marking a file written at
 * {@code writeHeader}. That holds only while every write of a region file's channel goes through {@code writeHeader}: checked here
 * against the real RegionFile bytecode of this Minecraft version, so an update that adds a write path fails this test.
 */
class RegionFileFlushSSTest {
	static final String CHANNEL = "java/nio/channels/FileChannel";

	/** Per method of RegionFile: the calls it makes, in order ("FileChannel.write", "RegionFile.writeHeader", ...). */
	static Map<String, List<String>> calls() throws Exception {
		Map<String, List<String>> m = new TreeMap<>();
		try (InputStream in = net.minecraft.world.level.chunk.storage.RegionFile.class.getResourceAsStream("RegionFile.class")) {
			new ClassReader(in.readAllBytes()).accept(new ClassVisitor(Opcodes.ASM9) {
				@Override
				public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] ex) {
					List<String> l = m.computeIfAbsent(name, k -> new ArrayList<>());
					return new MethodVisitor(Opcodes.ASM9) {
						@Override
						public void visitMethodInsn(int op, String owner, String n, String d, boolean itf) {
							l.add(owner.substring(owner.lastIndexOf('/') + 1) + "." + n);
						}

						@Override
						public void visitInvokeDynamicInsn(String n, String d, org.objectweb.asm.Handle bsm, Object... args) {
							for (Object a : args) {
								if (a instanceof org.objectweb.asm.Handle h) {
									l.add("lambda->" + h.getName()); // the lambda's body is its own method, checked as any other
								}
							}
						}
					};
				}
			}, 0);
		}
		return m;
	}

	@Test
	void everyChannelWriteGoesThroughWriteHeader() throws Exception {
		Map<String, List<String>> m = calls();
		Set<String> writers = new java.util.TreeSet<>();
		m.forEach((method, l) -> {
			if (l.stream().anyMatch(c -> c.equals("FileChannel.write") || c.equals("FileChannel.truncate") || c.equals("FileChannel.transferFrom")
				|| c.equals("FileChannel.map"))) {
				writers.add(method);
			}
		});
		// writeHeader itself; write (a chunk's sectors, then its header); padToFullSector (only from close, which forces itself);
		// writeToExternalFile (an oversized chunk's own .mcc channel, never forced by vanilla; only from write, which then writes the header)
		assertEquals(Set.of("writeHeader", "write", "padToFullSector", "writeToExternalFile"), writers, "the methods that write a channel");
		m.forEach((method, l) -> {
			if (l.contains("RegionFile.writeToExternalFile")) {
				assertEquals("write", method, "writeToExternalFile only from write");
			}
		});
		List<String> w = m.get("write");
		assertTrue(w.lastIndexOf("FileChannel.write") < w.indexOf("RegionFile.writeHeader"), "write marks the file after its sector writes");
		assertTrue(m.get("clear").contains("RegionFile.writeHeader"), "clear writes the header");
		m.forEach((method, l) -> {
			if (l.contains("RegionFile.padToFullSector")) {
				assertEquals("close", method, "padToFullSector only from close");
			}
			if (l.contains("FileChannel.force")) {
				assertTrue(method.equals("flush") || method.equals("close"), "force only in flush and close: " + method);
			}
		});
		assertTrue(m.get("close").contains("FileChannel.force"), "close forces the file itself");
	}

	@Test
	void theMixinMarksAtWriteHeaderAndSkipsOnlyAnUnwrittenFlush() throws Exception {
		String s = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/RegionFileFlushMixin.java"));
		assertTrue(s.contains("@Inject(method = \"writeHeader\", at = @At(\"HEAD\"))"));
		assertTrue(s.contains("@Inject(method = \"flush\", at = @At(\"HEAD\"), cancellable = true)"));
		int skip = s.indexOf("if (!architect$written && !SaveTiming.forceAll)");
		int clear = s.indexOf("architect$written = false;");
		assertTrue(skip > 0 && clear > skip, "cleared only on the forcing path, before the force runs");
		String json = Files.readString(Path.of("src/main/resources/architect_mc.mixins.json"));
		assertTrue(json.contains("\"RegionFileFlushMixin\""));
	}
}
