// ============================================
// INS cradle A: corner shoe for the OXTS RT3000 v4 (120 x 120 x 71 mm)
// Drops over one top corner of the unit and is located kinematically by six small pads:
// three under the top plate rest on the INS top, two on the -X skirt and one on the -Y
// skirt bear on the two side faces. Large faces only clear the INS by `gap`, so print
// marks and small surface features don't matter - only the pads touch.
// The phone seat runs along the INS X axis, so the phone's starting heading is the INS heading.
// Assumption: the chosen corner's two faces are free of connectors for skirt_d mm down.
// Print: upright as modelled, with tree supports under the top plate (only the pads need
// to come out clean - a light sand is fine). PLA, 0.2 mm layers.
// ============================================
include <common.scad>

ins = [120, 120, 71];   // [mm] RT3000 v4 outer size (x, y, z)
shoe = 70;              // [mm] how far the shoe runs along each face from the corner
skirt_d = 18;           // [mm] how far the skirt reaches down the side faces
skin = 3;               // [mm] skirt / top thickness
gap = 0.6;              // [mm] clearance between large faces and the INS; the pads close it
loc_pad_d = 6;          // [mm] locating pad diameter

module shoe_body() {
    // INS occupies x in [0, 120], y in [0, 120], z in [-71, 0]; the shoe sits on corner (0, 0).
    difference() {
        translate([-skin - gap, -skin - gap, -skirt_d]) cube([shoe + skin + gap, shoe + skin + gap, skirt_d + gap + skin]);
        translate([-gap, -gap, -skirt_d - eps]) cube([shoe + 1, shoe + 1, skirt_d + gap + eps]);
        // open the inside of the top plate so the INS top label/LEDs stay visible
        translate([shoe * 0.45, shoe * 0.45, -eps]) cylinder(r = shoe * 0.3, h = gap + skin + 2 * eps);
    }
    // three pads under the top plate (rest on the INS top, z = 0)
    for (p = [[10, 10], [shoe - 8, 10], [10, shoe - 8]])
        translate([p.x, p.y, 0]) cylinder(d = loc_pad_d, h = gap + eps);
    // two pads on the -X skirt and one on the -Y skirt (bear on the side faces x = 0, y = 0)
    for (y = [12, shoe - 10])
        translate([-gap - eps, y, -skirt_d / 2]) rotate([0, 90, 0]) cylinder(d = loc_pad_d, h = gap + eps);
    translate([shoe / 2, -gap - eps, -skirt_d / 2]) rotate([-90, 0, 0]) cylinder(d = loc_pad_d, h = gap + eps);
}

shoe_body();
// phone seat on the shoe's top, datum corner over the INS corner, long axis along INS +X
translate([0, 0, gap + skin]) phone_seat("INS");

// previews: the INS and the phone as ghosts
%translate([0, 0, -ins.z]) cube(ins);
if (show_phone) %translate([0, 0, gap + skin]) phone_ghost();
