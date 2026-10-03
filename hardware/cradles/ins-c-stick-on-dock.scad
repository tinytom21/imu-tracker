// ============================================
// INS cradle C: stick-on dock for the OXTS RT3000 v4
// A low plate that stays on the INS for the whole test campaign (VHB tape underneath).
// Two short lips hook over two top edges while it is stuck down, which squares it to the
// INS axes once; after that only the phone is picked up and put down.
// Lowest profile and no re-seating of the cradle itself between runs.
// ============================================
include <common.scad>

ins = [120, 120, 71];
base_t = 2.5;      // [mm] base plate (sits on 0.5-1 mm VHB)
lip_d = 6;         // [mm] alignment lips down the side faces
lip_t = 2;         // [mm]
fit = 0.2;         // [mm]

module dock() {
    // base under the phone seat footprint, starting at the INS corner (0, 0)
    translate([0, 0, 0]) cube([90, 80, base_t]);
    // alignment lips over the -X and -Y top edges
    translate([-lip_t - fit, -lip_t - fit, -lip_d]) cube([lip_t, 80 + lip_t + fit, lip_d + base_t]);
    translate([-lip_t - fit, -lip_t - fit, -lip_d]) cube([90 + lip_t + fit, lip_t, lip_d + base_t]);
}

dock();
translate([2, 2, base_t]) phone_seat("INS");

%translate([0, 0, -ins.z]) cube(ins);
if (show_phone) %translate([2, 2, base_t]) phone_ghost();
