<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE eagle SYSTEM "eagle.dtd">
<!-- Census fixture, written by hand from the structure of the public eagle.dtd. A small two-sheet
     schematic that sets, wherever it can, a value other than Eagle's default, so that a property the
     importer does not read shows up in tests/e2e/census-eagle.cjs. It is not the schematic of
     census.brd: each file stands alone. Mirrored instances use MR0 only. -->
<eagle version="9.6.2">
<drawing>
<settings>
<setting alwaysvectorfont="yes"/>
<setting verticaltext="up"/>
</settings>
<grid distance="0.05" unitdist="inch" unit="inch" style="dots" multiple="2" display="yes" altdistance="0.025" altunitdist="inch" altunit="inch"/>
<layers>
<layer number="91" name="Nets" color="2" fill="1" visible="yes" active="yes"/>
<layer number="92" name="Busses" color="1" fill="1" visible="yes" active="yes"/>
<layer number="94" name="Symbols" color="4" fill="1" visible="yes" active="yes"/>
<layer number="95" name="Names" color="7" fill="1" visible="yes" active="yes"/>
<layer number="96" name="Values" color="7" fill="1" visible="yes" active="yes"/>
<layer number="97" name="Info" color="7" fill="1" visible="yes" active="yes"/>
<layer number="98" name="Guide" color="6" fill="1" visible="yes" active="yes"/>
</layers>
<schematic xreflabel="%F%N/%S.%C%R" xrefpart="/%S.%C%R">
<description>Census schematic: a sensor with a buffer gate.</description>
<libraries>
<library name="census-lib" urn="urn:adsk.eagle:library:900001">
<description>Census library: parts written for the census.</description>
<packages>
<package name="QFN11" urn="urn:adsk.eagle:footprint:900012/1">
<smd name="1" x="-1.5" y="1" dx="0.8" dy="0.3" layer="1"/>
<smd name="2" x="-1.5" y="0.5" dx="0.8" dy="0.3" layer="1"/>
<smd name="3" x="-1.5" y="0" dx="0.8" dy="0.3" layer="1"/>
<smd name="4" x="-1.5" y="-0.5" dx="0.8" dy="0.3" layer="1"/>
<smd name="5" x="-1.5" y="-1" dx="0.8" dy="0.3" layer="1"/>
<smd name="6" x="1.5" y="-1" dx="0.8" dy="0.3" layer="1"/>
<smd name="7" x="1.5" y="-0.5" dx="0.8" dy="0.3" layer="1"/>
<smd name="8" x="1.5" y="0" dx="0.8" dy="0.3" layer="1"/>
<smd name="9" x="1.5" y="0.5" dx="0.8" dy="0.3" layer="1"/>
<smd name="EP" x="0" y="0" dx="1.6" dy="1.6" layer="1"/>
<smd name="B1" x="0" y="1.6" dx="0.5" dy="0.5" layer="16"/>
</package>
</packages>
<symbols>
<symbol name="SENSOR" urn="urn:adsk.eagle:symbol:900010/1">
<description>Census sensor body.</description>
<wire x1="-7.62" y1="5.08" x2="7.62" y2="5.08" width="0.4064" layer="94"/>
<wire x1="7.62" y1="5.08" x2="7.62" y2="-10.16" width="0.4064" layer="94"/>
<wire x1="7.62" y1="-10.16" x2="-7.62" y2="-10.16" width="0.4064" layer="94"/>
<wire x1="-7.62" y1="-10.16" x2="-7.62" y2="5.08" width="0.4064" layer="94"/>
<wire x1="-5.08" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94" curve="90" style="shortdash"/>
<circle x="5.08" y="-7.62" radius="0.5" width="0" layer="94"/>
<rectangle x1="-1" y1="-0.5" x2="1" y2="0.5" layer="94" rot="R90"/>
<polygon width="0.1" layer="94">
<vertex x="2" y="-2"/>
<vertex x="4" y="-2"/>
<vertex x="3" y="-0.5"/>
</polygon>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-12.7" size="1.778" layer="96" align="top-left">&gt;VALUE</text>
<text x="0" y="-5" size="1.27" layer="97" font="fixed" ratio="10" rot="R180">SENS</text>
<pin name="VDD" x="-12.7" y="2.54" length="middle" direction="pwr"/>
<pin name="EN" x="-15.24" y="-2.54" length="long" direction="in" function="clk" visible="pad"/>
<pin name="IO" x="-10.16" y="-7.62" length="short" direction="io" function="dotclk"/>
<pin name="OUT" x="10.16" y="2.54" length="short" direction="out" function="dot" visible="pin" rot="R180"/>
<pin name="HIZ" x="12.7" y="-2.54" length="middle" direction="hiz" swaplevel="1" rot="R180"/>
<pin name="OC" x="10.16" y="-5.08" length="short" direction="oc" swaplevel="1" rot="R180"/>
<pin name="NC" x="7.62" y="-7.62" length="point" direction="nc" visible="off" rot="R180"/>
<pin name="GND@1" x="-2.54" y="-12.7" length="short" direction="pwr" rot="R90"/>
<pin name="GND@2" x="2.54" y="-12.7" length="short" direction="pwr" rot="R90"/>
</symbol>
<symbol name="BUF">
<wire x1="-5.08" y1="2.54" x2="5.08" y2="0" width="0.254" layer="94"/>
<wire x1="5.08" y1="0" x2="-5.08" y2="-2.54" width="0.254" layer="94"/>
<wire x1="-5.08" y1="-2.54" x2="-5.08" y2="2.54" width="0.254" layer="94"/>
<text x="0" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<pin name="IN" x="-7.62" y="0" length="short" direction="in"/>
<pin name="OUT" x="7.62" y="0" length="short" direction="out" rot="R180"/>
</symbol>
<symbol name="VCC-SUP">
<wire x1="-1.27" y1="0" x2="1.27" y2="0" width="0.254" layer="94"/>
<text x="-1.5" y="1" size="1.778" layer="96">&gt;VALUE</text>
<pin name="VCC" x="0" y="-2.54" visible="off" length="short" direction="sup" rot="R90"/>
</symbol>
<symbol name="FRAME-A4">
<frame x1="0" y1="0" x2="279.4" y2="190.5" columns="6" rows="4" layer="94" border-bottom="no"/>
</symbol>
</symbols>
<devicesets>
<deviceset name="SENSOR*" prefix="U" uservalue="yes" urn="urn:adsk.eagle:component:900020/1" library_version="3">
<description>Census sensor in two technologies.</description>
<gates>
<gate name="A" symbol="SENSOR" x="0" y="0" addlevel="must"/>
<gate name="B" symbol="BUF" x="25.4" y="0" addlevel="can" swaplevel="1"/>
</gates>
<devices>
<device name="-QFN" package="QFN11">
<connects>
<connect gate="A" pin="VDD" pad="1"/>
<connect gate="A" pin="OUT" pad="2"/>
<connect gate="A" pin="EN" pad="3"/>
<connect gate="A" pin="IO" pad="4"/>
<connect gate="A" pin="HIZ" pad="5"/>
<connect gate="A" pin="OC" pad="6"/>
<connect gate="A" pin="GND@1" pad="EP"/>
<connect gate="A" pin="GND@2" pad="7 B1" route="any"/>
<connect gate="B" pin="IN" pad="8"/>
<connect gate="B" pin="OUT" pad="9"/>
</connects>
<package3dinstances>
<package3dinstance package3d_urn="urn:adsk.eagle:package:900013/1"/>
</package3dinstances>
<technologies>
<technology name="LP">
<attribute name="MPN" value="CS-100LP" constant="no"/>
<attribute name="POWER" value="1mW"/>
</technology>
<technology name="HP">
<attribute name="MPN" value="CS-100HP" constant="no"/>
<attribute name="POWER" value="5mW"/>
</technology>
</technologies>
</device>
</devices>
</deviceset>
<deviceset name="VCC" prefix="SUPPLY">
<gates>
<gate name="G$1" symbol="VCC-SUP" x="0" y="0" addlevel="request"/>
</gates>
<devices>
<device name="">
<technologies>
<technology name=""/>
</technologies>
</device>
</devices>
</deviceset>
<deviceset name="FRAME">
<gates>
<gate name="G$1" symbol="FRAME-A4" x="0" y="0" addlevel="always"/>
</gates>
<devices>
<device name="">
<technologies>
<technology name=""/>
</technologies>
</device>
</devices>
</deviceset>
</devicesets>
</library>
</libraries>
<attributes>
<attribute name="AUTHOR" value="Census"/>
</attributes>
<variantdefs>
<variantdef name="LITE"/>
<variantdef name="FULL" current="yes"/>
</variantdefs>
<classes>
<class number="0" name="default" width="0" drill="0">
</class>
<class number="1" name="power" width="0.5" drill="0.4">
<clearance class="1" value="0.3"/>
</class>
</classes>
<parts>
<part name="U1" library="census-lib" library_urn="urn:adsk.eagle:library:900001" deviceset="SENSOR*" device="-QFN" package3d_urn="urn:adsk.eagle:package:900013/1" technology="LP" value="CS-100LP">
<attribute name="MPN" value="CS-100LP-T"/>
<attribute name="NOTE" value="hand-solder"/>
<variant name="LITE" populate="no"/>
<variant name="FULL" value="CS-100HP" technology="HP"/>
</part>
<part name="SUPPLY1" library="census-lib" deviceset="VCC" device=""/>
<part name="FRAME1" library="census-lib" deviceset="FRAME" device=""/>
</parts>
<sheets>
<sheet>
<description>Sheet one: the sensor.</description>
<plain>
<text x="25.4" y="170.18" size="2.54" layer="97" font="proportional" ratio="10" rot="R90" align="center">Census sheet</text>
<text x="25.4" y="160.02" size="1.778" layer="98">guide note</text>
<wire x1="100" y1="100" x2="120" y2="100" width="0.3" layer="97" style="dashdot"/>
<circle x="130" y="100" radius="2" width="0.2" layer="97"/>
<rectangle x1="140" y1="98" x2="144" y2="102" layer="97" rot="R45"/>
<polygon width="0.2" layer="97">
<vertex x="150" y="98"/>
<vertex x="154" y="98"/>
<vertex x="152" y="102"/>
</polygon>
<frame x1="90" y1="90" x2="160" y2="110" columns="5" rows="3" layer="97" border-left="no"/>
<dimension x1="100" y1="80" x2="120" y2="80" x3="110" y3="78" textsize="1.778" layer="97" dtype="horizontal"/>
</plain>
<instances>
<instance part="U1" gate="A" x="50.8" y="50.8" rot="MR0" smashed="yes">
<attribute name="NAME" x="45.72" y="58.42" size="2" layer="95" font="vector" ratio="12"/>
<attribute name="VALUE" x="45.72" y="40.64" size="1.5" layer="96" display="off"/>
<attribute name="MPN" x="45.72" y="38.1" size="1.27" layer="97" display="value"/>
</instance>
<instance part="SUPPLY1" gate="G$1" x="30.48" y="66.04"/>
<instance part="FRAME1" gate="G$1" x="0" y="0"/>
</instances>
<busses>
<bus name="D[0..3]">
<segment>
<wire x1="10.16" y1="30.48" x2="40.64" y2="30.48" width="0.762" layer="92"/>
</segment>
</bus>
</busses>
<nets>
<net name="VCC" class="1">
<segment>
<pinref part="U1" gate="A" pin="VDD"/>
<pinref part="SUPPLY1" gate="G$1" pin="VCC"/>
<wire x1="63.5" y1="53.34" x2="63.5" y2="63.5" width="0.1524" layer="91"/>
<wire x1="63.5" y1="63.5" x2="30.48" y2="63.5" width="0.3" layer="91" style="longdash"/>
<junction x="50.8" y="63.5"/>
<label x="40.64" y="63.5" size="1.778" layer="95" xref="yes"/>
</segment>
</net>
<net name="SENSE_OUT" class="0">
<segment>
<pinref part="U1" gate="A" pin="OUT"/>
<wire x1="40.64" y1="53.34" x2="30.48" y2="53.34" width="0.1524" layer="91"/>
<wire x1="30.48" y1="53.34" x2="25.4" y2="48.26" width="0.1524" layer="91" curve="90"/>
<label x="35.56" y="54" size="2" layer="95" font="vector" ratio="10" rot="R90" align="center"/>
</segment>
</net>
</nets>
</sheet>
<sheet>
<description>Sheet two: the buffer gate.</description>
<plain>
</plain>
<instances>
<instance part="U1" gate="B" x="50.8" y="50.8" rot="R90"/>
</instances>
<busses>
</busses>
<nets>
<net name="SENSE_OUT" class="0">
<segment>
<pinref part="U1" gate="B" pin="OUT"/>
<wire x1="50.8" y1="58.42" x2="50.8" y2="66.04" width="0.1524" layer="91"/>
<label x="50.8" y="63.5" size="1.778" layer="95" rot="R90" xref="yes"/>
</segment>
</net>
</nets>
</sheet>
</sheets>
</schematic>
</drawing>
</eagle>
