import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.jacoco.cli.internal.asm.AnnotationVisitor;
import org.jacoco.cli.internal.asm.Attribute;
import org.jacoco.cli.internal.asm.ClassReader;
import org.jacoco.cli.internal.asm.ClassVisitor;
import org.jacoco.cli.internal.asm.ClassWriter;
import org.jacoco.cli.internal.asm.MethodVisitor;
import org.jacoco.cli.internal.asm.Opcodes;
import org.jacoco.cli.internal.asm.TypePath;

/**
 * Gate execution coverage (docs/GATES.md "Execution coverage (JaCoCo)"): a test and gate tool, never part of the mod. Compiled
 * against the pinned JaCoCo CLI jar (its shaded ASM).
 * <p>
 * {@code skel <out.json> <classes root>...}: for every class file, the digest of what a JVM can observe of a class it LOADED but never
 * ENTERED: the class with every method body removed except the static initializer's. That keeps the flags, the super class and
 * interfaces, the fields with their constant values, every method and field declaration with its flags, the annotations, and the
 * InnerClasses, NestHost/NestMembers, PermittedSubclasses and Record attributes (dispatch, instanceof and reflection read them),
 * plus the {@code <clinit>} body. Debug attributes and stack map frames are dropped: line numbers moving does not count. The
 * digest is taken over a class file re-written from the tree (symbolic: constant-pool indices of the original play no part).
 * Out: { "fqn": "sha1" }. A class that fails to parse is left out (the key then uses its whole class-file digest).
 */
public final class GateCovTool {
	public static void main(String[] args) throws Exception {
		if (args.length < 2 || !args[0].equals("skel")) {
			System.err.println("usage: GateCovTool skel <out.json> <classes root>...");
			System.exit(2);
		}
		Map<String, String> out = new TreeMap<>();
		List<String> failed = new ArrayList<>();
		for (int i = 2; i < args.length; i++) {
			Path root = Path.of(args[i]);
			if (!Files.isDirectory(root)) continue;
			try (Stream<Path> s = Files.walk(root)) {
				for (Path p : (Iterable<Path>) s.filter(x -> x.toString().endsWith(".class"))::iterator) {
					String rel = root.relativize(p).toString().replace('\\', '/');
					String fqn = rel.substring(0, rel.length() - 6).replace('/', '.');
					try {
						out.put(fqn, skeleton(Files.readAllBytes(p)));
					} catch (Exception e) {
						failed.add(fqn + ": " + e);
					}
				}
			}
		}
		StringBuilder sb = new StringBuilder("{\n");
		boolean first = true;
		for (var e : out.entrySet()) {
			if (!first) sb.append(",\n");
			first = false;
			sb.append(" \"").append(e.getKey().replace("\\", "\\\\").replace("\"", "\\\"")).append("\": \"").append(e.getValue()).append('"');
		}
		sb.append("\n}\n");
		Files.writeString(Path.of(args[1]), sb.toString());
		for (String f : failed) System.err.println("skel: " + f);
		System.out.println("skel " + out.size() + " classes, " + failed.size() + " failed");
	}

	static String skeleton(byte[] bytes) throws Exception {
		ClassWriter cw = new ClassWriter(0);
		new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM9, cw) {
			@Override
			public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] exceptions) {
				MethodVisitor w = super.visitMethod(access, name, desc, sig, exceptions);
				return name.equals("<clinit>") ? w : new Declaration(w);
			}
		}, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
		return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(cw.toByteArray()));
	}

	/** A method's declaration only: its annotations, parameter annotations, annotation default and attributes; no code. */
	static final class Declaration extends MethodVisitor {
		private final MethodVisitor w;

		Declaration(MethodVisitor w) {
			super(Opcodes.ASM9); // no delegate: every code visit is dropped
			this.w = w;
		}

		@Override
		public void visitParameter(String name, int access) {
			w.visitParameter(name, access);
		}

		@Override
		public AnnotationVisitor visitAnnotationDefault() {
			return w.visitAnnotationDefault();
		}

		@Override
		public AnnotationVisitor visitAnnotation(String desc, boolean visible) {
			return w.visitAnnotation(desc, visible);
		}

		@Override
		public AnnotationVisitor visitTypeAnnotation(int typeRef, TypePath typePath, String desc, boolean visible) {
			return w.visitTypeAnnotation(typeRef, typePath, desc, visible);
		}

		@Override
		public void visitAnnotableParameterCount(int count, boolean visible) {
			w.visitAnnotableParameterCount(count, visible);
		}

		@Override
		public AnnotationVisitor visitParameterAnnotation(int parameter, String desc, boolean visible) {
			return w.visitParameterAnnotation(parameter, desc, visible);
		}

		@Override
		public void visitAttribute(Attribute a) {
			w.visitAttribute(a);
		}

		@Override
		public void visitEnd() {
			w.visitEnd();
		}
	}
}
