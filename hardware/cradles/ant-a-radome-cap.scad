// ============================================
// Antenna cradle A: radome cap for the Tallysman TW7972 (69 mm dia, 22 mm high)
// A shallow cup that drops over the top of the antenna, centred by the cylindrical side
// and resting on three pads on the radome. The phone seat is centred on the antenna's
// vertical axis, so the cradle-to-phase-centre offset is purely vertical and does not
// change with how the cap is turned. An arrow is lined up with the vehicle's forward
// direction by eye (phone heading within ~10 deg keeps the phone's own sensor offset < 1 cm).
// Assumption: radome top is roughly flat/domed and the side is a 69 mm cylinder for >= 10 mm.
// ============================================
include <common.scad>

ant_d = 69;        // [mm] antenna outer diameter
ant_h = 22;        // [mm] antenna height
cup_depth = 10;    // [mm] how far the cup reaches down the side
skin = 2.5;        // [mm]
fit = 0.4;         // [mm] radial clearance
rest_h = 1;        // [mm] the three pads that rest on the radome

module cap() {
    difference() {
        cylinder(d = ant_d + 2 * (fit + skin), h = cup_depth + skin);
        translate([0, 0, -eps]) cylinder(d = ant_d + 2 * fit, h = cup_depth + eps);
    }
    // three pads on the ceiling: a three-point rest on the radome
    for (a = [90, 210, 330]) rotate(a) translate([ant_d * 0.33, 0, cup_depth - rest_h]) cylinder(d = 6, h = rest_h + eps);
}

// antenna top is at z = 0; cap rests on it
translate([0, 0, -cup_depth + rest_h]) cap();
c = seat_phone_centre();
translate([-c.x, -c.y, rest_h + skin]) phone_seat("ANT");

%translate([0, 0, -ant_h]) cylinder(d = ant_d, h = ant_h);
if (show_phone) %translate([-c.x, -c.y, rest_h + skin]) phone_ghost();
