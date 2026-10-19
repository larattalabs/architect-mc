// Dumps the per-block facts that the data generator's blocks.json report does not carry: the block's Java class
// chain (its family), the default state's collision boxes, light emission per state, light dampening, shape-based
// light occlusion, redstone conductivity and the block's item; (6c H) whether vanilla's FlowingFluid.canHoldFluid refuses the
// default state for flowing water and for flowing lava (fluid-stopping), and its fire facts (ignitedByLava; FireBlock's ignite and burn
// odds). Run by kit/tools/gen-blocks.mjs with the Java 25
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

  /**
   * (6c H) FlowingFluid.canHoldSpecificFluid(BlockGetter, BlockPos, BlockState, Fluid) by reflection (private static): null when absent.
   * 26.3's canHoldFluid is canHoldAnyFluid (a LiquidBlockContainer, or the block tag washed_away_by_fluids, which this dump can't read:
   * no data packs) and canHoldSpecificFluid (a container's canPlaceLiquid, else true): the generator joins them with the jar's tags.
   */
  static java.lang.reflect.Method canHold() {
    for (java.lang.reflect.Method m : net.minecraft.world.level.material.FlowingFluid.class.getDeclaredMethods()) {
      Class<?>[] p = m.getParameterTypes();
      if (m.getName().equals("canHoldSpecificFluid") && p.length == 4 && java.lang.reflect.Modifier.isStatic(m.getModifiers())) { m.setAccessible(true); return m; }
    }
    return null;
  }

  /** (6c H) FireBlock's ignite or burn odds of a state by reflection (private): -1 when absent. */
  static int odds(String name, BlockState s) {
    try {
      java.lang.reflect.Method m = net.minecraft.world.level.block.FireBlock.class.getDeclaredMethod(name, BlockState.class);
      m.setAccessible(true);
      return (Integer) m.invoke(net.minecraft.world.level.block.Blocks.FIRE, s);
    } catch (Throwable t) { return -1; }
  }

  public static void main(String[] args) throws Exception {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
    var g = EmptyBlockGetter.INSTANCE;
    var pos = BlockPos.ZERO;
    java.lang.reflect.Method hold = canHold();
    if (hold == null) throw new IllegalStateException("FlowingFluid.canHoldSpecificFluid not found");
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
        // (6b) replaceable (TerrainFit's natural plants), a block entity, and a valid mob spawn surface (M5: a zombie on top)
        boolean replaceable = d.canBeReplaced();
        boolean be = d.hasBlockEntity();
        boolean spawn;
        try { spawn = d.isValidSpawn(g, pos, net.minecraft.world.entity.EntityTypes.ZOMBIE); } catch (Throwable t) { spawn = false; }
        // (6c H) a LiquidBlockContainer, and whether it takes flowing water and flowing lava (canHoldSpecificFluid; a block it can't decide
        // takes them: conservative, so it is no fluid-stopping block)
        boolean container = b instanceof net.minecraft.world.level.block.LiquidBlockContainer;
        boolean holdsW, holdsL;
        try {
          holdsW = (Boolean) hold.invoke(null, g, pos, d, net.minecraft.world.level.material.Fluids.FLOWING_WATER);
          holdsL = (Boolean) hold.invoke(null, g, pos, d, net.minecraft.world.level.material.Fluids.FLOWING_LAVA);
        } catch (Throwable t) { holdsW = true; holdsL = true; }
        boolean lavaLights = d.ignitedByLava();
        int ignite = odds("getIgniteOdds", d), burn = odds("getBurnOdds", d);
        if (!first) w.write(",\n");
        first = false;
        w.write(q(id) + ":{\"cls\":[" + String.join(",", chain) + "],\"collision\":[" + boxes + "],\"emit\":[" + String.join(",", emit) + "]"
          + ",\"dampening\":" + d.getLightDampening() + ",\"shapeOcclusion\":" + d.useShapeForLightOcclusion()
          + ",\"solidRender\":" + d.isSolidRender() + ",\"conductor\":" + conductor + ",\"item\":" + q(item) + ",\"replaceable\":" + replaceable + ",\"be\":" + be + ",\"spawn\":" + spawn + ",\"container\":" + container + ",\"holdsFlowingWater\":" + holdsW + ",\"holdsFlowingLava\":" + holdsL + ",\"lavaLights\":" + lavaLights + ",\"ignite\":" + ignite + ",\"burn\":" + burn + "}");
      }
      w.write("\n}\n");
    }
    System.exit(0);
  }
}
