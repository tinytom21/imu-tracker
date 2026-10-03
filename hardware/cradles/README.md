# Offset cradles (concept mock-ups)

3D-printable cradles that put the phone in exactly the same place every time, on the INS
(OXTS RT3000 v4, 120 × 120 × 71 mm) and on a GNSS antenna (Tallysman TW7972, Ø69 × 22 mm).

The cradles don't need to put the phone's sensor over the INS measurement origin or the
antenna phase centre. Each cradle has a **fixed offset** to its reference point, measured
once (from the drawings or with calipers) and added to the app's result:

```
lever arm (INS frame) = app result  −  INS-cradle offset  +  antenna-cradle offset
```

## How every cradle locates the phone (`common.scad`)

- **3 pads** carry the phone, so it can't rock.
- **3-2-1 datum**: a long wall with 2 bumps and a short wall with 1 bump. Push the phone
  into the corner and it can only sit one way.
- **2° slope towards that corner**, so gravity seats the phone.
- Open on the other two sides, with finger notches for one-handed pick-up.
- A raised **forward arrow** marks the cradle's +X.

Phone size is a parameter (`phone_l`, `phone_w`, `phone_t`, plus `case_allow` for a case).
Defaults are a bare Galaxy S23.

## Concepts

| File | Fits | How it locates | Notes |
|---|---|---|---|
| `ins-a-corner-shoe.scad` | RT3000 v4, one top corner | Two inner faces on two side faces + top plate | Compact; keyed to the INS axes; needs two connector-free faces near one corner |
| `ins-b-top-hat.scad` | RT3000 v4, whole top | Skirt on 3 sides, datum bumps on 2 faces | Most rigid; 4th side open for connectors; largest print |
| `ins-c-stick-on-dock.scad` | RT3000 v4 top, VHB-taped | Lips square it to two edges once, then it stays | Lowest profile; cradle never re-seated between runs |
| `ant-a-radome-cap.scad` | TW7972 radome | Centred by the antenna side, rests on 3 pads on the radome | Seat on the antenna axis, so the offset is purely vertical |
| `ant-b-roof-collar.scad` | TW7972, standing on the roof | Centred by the antenna side, height from the roof (3 feet) | Independent of radome shape; cable slot |

## Assumptions to confirm

- RT3000 v4 outer size 120 × 120 × 71 mm (datasheet); top face flat; connector side and
  any top-face features not yet checked against drawing 14A0100 / the STEP file.
- TW7972: Ø69 mm, 22 mm high (datasheet); side cylindrical for at least 10 mm; cable exits
  the side.
- Antenna cradles need their arrow lined up with the vehicle's forward direction by eye:
  within ~10° keeps the phone's own sensor offset under ~1 cm.
- Clearances (`fit`, `clear`) are first guesses for a typical FDM printer; the first print
  tells.
