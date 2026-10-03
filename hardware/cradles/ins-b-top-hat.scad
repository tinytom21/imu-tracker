// ============================================
// INS cradle B: top hat for the OXTS RT3000 v4 (120 x 120 x 71 mm)
// A lid that covers the whole top with a skirt on three sides. Two adjacent skirt faces
// carry locating bumps (the datum faces); the user pushes the hat into that corner.
// The fourth side is open for the connectors (connector_side assumed to be -Y here).
// Phone seat centred on the top, long axis along INS +X.
// ============================================
include <common.scad>

ins = [120, 120, 71];
skirt_d = 14;      // [mm]
skin = 3;          // [mm]
fit = 0.6;         // [mm] skirt clearance (datum bumps close the gap)
bump = 0.6;        // [mm] datum bump height = fit, so the bumps touch

module hat() {
    difference() {
        translate([-skin - fit, -fit, -skirt_d]) cube([ins.x + 2 * (skin + fit), ins.y + skin + 2 * fit, skirt_d + skin]);
        translate([-fit, -fit - eps, -skirt_d - eps]) cube([ins.x + 2 * fit, ins.y + 2 * fit + eps, skirt_d + eps]);
        // window over the top centre to save material and keep the INS label visible
        translate([ins.x / 2, ins.y / 2, -eps]) cylinder(d = 60, h = skin + 2 * eps);
    }
    // datum bumps: two on the -X skirt face, one on the +Y skirt face
    for (y = [ins.y * 0.25, ins.y * 0.75]) translate([-fit, y, -skirt_d / 2]) rotate([0, 90, 0]) cylinder(d = 5, h = bump * 2, center = true);
    translate([ins.x / 2, ins.y + fit, -skirt_d / 2]) rotate([90, 0, 0]) cylinder(d = 5, h = bump * 2, center = true);
}

hat();
c = seat_phone_centre();
translate([ins.x / 2 - c.x, ins.y / 2 - c.y, skin]) phone_seat("INS");

%translate([0, 0, -ins.z]) cube(ins);
if (show_phone) %translate([ins.x / 2 - c.x, ins.y / 2 - c.y, skin]) phone_ghost();
