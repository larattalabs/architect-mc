// Dumps the per-block facts that the data generator's blocks.json report does not carry: the block's Java class
// chain (its family), the default state's collision boxes, light emission per state, light dampening, shape-based
// light occlusion, redstone conductivity and the block's item. Run by kit/tools/gen-blocks.mjs with the Java 25
// source launcher against the unobfuscated 26.3 server jar + its bundled libraries:
//   java -cp "<server-26.3.jar>:<libraries/**.jar>" BlockDump.java <out.json>
import java.io.FileWriter;
import java.io.Writer;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.AABB;

public class BlockDump {
  static String q(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
  static String num(double d) { return d == Math.rint(d) ? Long.toString((long) d) : Double.toString(Math.round(d * 10000) / 10000.0); }

  @SuppressWarnings({ "rawtypes", "unchecked" })
  static String propsOf(BlockState s) {
    List<String> out = new ArrayList<>();
    for (Property p : s.getProperties()) out.add(q(p.getName()) + ":" + q(p.getName(s.getValue(p))));
    return "{" + String.join(",", out) + "}";
  }

  public static void main(String[] args) throws Exception {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
    var g = EmptyBlockGetter.INSTANCE;
    var pos = BlockPos.ZERO;
    try (Writer w = new FileWriter(args[0])) {
      w.write("{\n");
      boolean first = true;
      for (Block b : BuiltInRegistries.BLOCK) {
        String id = BuiltInRegistries.BLOCK.getKey(b).toString();
        List<String> chain = new ArrayList<>();
        for (Class<?> c = b.getClass(); c != null && c != Object.class; c = c.getSuperclass()) chain.add(q(c.getSimpleName()));
        BlockState d = b.defaultBlockState();
        String boxes = d.getCollisionShape(g, pos).toAabbs().stream()
          .map((AABB a) -> "[" + num(a.minX) + "," + num(a.minY) + "," + num(a.minZ) + "," + num(a.maxX) + "," + num(a.maxY) + "," + num(a.maxZ) + "]")
          .collect(Collectors.joining(","));
        List<String> emit = new ArrayList<>();
        for (BlockState s : b.getStateDefinition().getPossibleStates()) {
          int e = s.getLightEmission();
          if (e > 0) emit.add("[" + propsOf(s) + "," + e + "]");
        }
        boolean conductor;
        try { conductor = d.isRedstoneConductor(g, pos); } catch (Throwable t) { conductor = false; }
        String item = BuiltInRegistries.ITEM.getKey(b.asItem()).toString();
        if (!first) w.write(",\n");
        first = false;
        w.write(q(id) + ":{\"cls\":[" + String.join(",", chain) + "],\"collision\":[" + boxes + "],\"emit\":[" + String.join(",", emit) + "]"
          + ",\"dampening\":" + d.getLightDampening() + ",\"shapeOcclusion\":" + d.useShapeForLightOcclusion()
          + ",\"solidRender\":" + d.isSolidRender() + ",\"conductor\":" + conductor + ",\"item\":" + q(item) + "}");
      }
      w.write("\n}\n");
    }
    System.exit(0);
  }
}
