<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE eagle SYSTEM "eagle.dtd">
<eagle version="9.6.2"><drawing><layers/><schematic><libraries><library name="l">
<packages><package name="P"><smd name="1" x="0" y="0" dx="1" dy="1" layer="1"/><smd name="2" x="1" y="0" dx="1" dy="1" layer="1"/></package></packages>
<symbols><symbol name="S"><wire x1="-2.54" y1="0" x2="2.54" y2="0" width="0.254" layer="94"/>
<pin name="A" x="5.08" y="0" length="short" direction="pas" rot="R180"/><pin name="B" x="-5.08" y="0" length="short" direction="pas"/></symbol></symbols>
<devicesets><deviceset name="D"><gates><gate name="G$1" symbol="S" x="0" y="0"/></gates>
<devices><device name="" package="P"><connects><connect gate="G$1" pin="A" pad="1"/><connect gate="G$1" pin="B" pad="2"/></connects></device></devices></deviceset></devicesets>
</library></libraries>
<parts><part name="R1" library="l" deviceset="D" device=""/><part name="R2" library="l" deviceset="D" device=""/></parts>
<sheets><sheet><instances>
<instance part="R1" gate="G$1" x="50.8" y="50.8" rot="R90"/>
<instance part="R2" gate="G$1" x="50.8" y="50.8" rot="MR90"/>
</instances></sheet></sheets></schematic></drawing></eagle>
