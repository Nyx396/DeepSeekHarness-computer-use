// Plugin-owned presentation for the pinned MIT Windows takeover host.
// The host's stop hook, target handling and pointer position logic are retained.
namespace DshTakeover {
  public static class OverlayVisuals {
    internal static readonly System.Diagnostics.Stopwatch Clock = System.Diagnostics.Stopwatch.StartNew();
    internal static GraphicsPath Rounded(RectangleF r, float radius) {
      var p=new GraphicsPath(); float d=radius*2;
      p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);
      p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;
    }
    internal static float BadgeScale(int width) {return Math.Max(1f,Math.Min(2f,width/1920f));}
    internal static Bitmap Badge(int screenWidth,string text) {
      float scale=BadgeScale(screenWidth);
      using(var font=new Font("Microsoft YaHei UI",10f*scale,FontStyle.Regular,GraphicsUnit.Point)) {
        string label=text+"  ·  Esc 停止";
        SizeF measured;using(var scratch=new Bitmap(1,1))using(var g=Graphics.FromImage(scratch))measured=g.MeasureString(label,font);
        int width=Math.Max(1,(int)Math.Ceiling(Math.Min(screenWidth-48,measured.Width+42*scale)));
        int height=(int)Math.Ceiling(42*scale);
        var image=new Bitmap(width,height,PixelFormat.Format32bppPArgb);
        using(var g=Graphics.FromImage(image)) {
          g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;
          using(var shape=Rounded(new RectangleF(1,1,width-2,height-2),12*scale)) {
            using(var fill=new SolidBrush(Color.FromArgb(238,21,38,59)))g.FillPath(fill,shape);
            using(var outline=new Pen(Color.FromArgb(190,101,188,255),1))g.DrawPath(outline,shape);
          }
          using(var brush=new SolidBrush(Color.FromArgb(255,234,246,255)))
          using(var format=new StringFormat {Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center,Trimming=StringTrimming.EllipsisCharacter,FormatFlags=StringFormatFlags.NoWrap})
            g.DrawString(label,font,brush,new RectangleF(12,0,width-24,height),format);
        }
        return image;
      }
    }
    public static int EdgeDepth(int width,int height,double dpi) {
      return Math.Min(Math.Min(width,height)/4,(int)Math.Round(52*Math.Max(1,Math.Min(3,dpi/96.0))));
    }
    public static Bitmap DrawFrame(int width,int height,string text,string position,double seconds) {
      return DrawFrame(width,height,text,position,seconds,96);
    }
    public static Bitmap DrawFrame(int width,int height,string text,string position,double seconds,double dpi) {
      var image=new Bitmap(width,height,PixelFormat.Format32bppPArgb);
      int depth=EdgeDepth(width,height,dpi);
      var field=new AuroraField(width,height,depth,seconds);
      using(var g=Graphics.FromImage(image)) {
        g.Clear(Color.Transparent);
        foreach(var r in AuroraField.Tiles(width,height,depth))using(var edge=field.Draw(r))g.DrawImageUnscaled(edge,r.Location);
        using(var badge=Badge(width,text)) {
          float scale=BadgeScale(width);
          int y=position=="bottom"?height-badge.Height-(int)(22*scale):(int)(22*scale);
          g.DrawImageUnscaled(badge,(width-badge.Width)/2,y);
        }
      }
      return image;
    }
    public static Bitmap DrawPointer(float zoom,bool left,bool up) {
      var image=new Bitmap((int)Math.Ceiling(120*zoom),(int)Math.Ceiling(84*zoom),PixelFormat.Format32bppPArgb);
      using(var g=Graphics.FromImage(image)) {
        g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;g.ScaleTransform(zoom,zoom);
        float x=left?96:24,y=up?60:24;
        var saved=g.Save();g.TranslateTransform(x,y);g.ScaleTransform(left?-1:1,up?-1:1);
        using(var arrow=new GraphicsPath()) {
          arrow.AddPolygon(new PointF[]{new PointF(0,0),new PointF(1,29),new PointF(8,22),new PointF(15,35),new PointF(21,32),new PointF(14,19),new PointF(27,18)});
          // Several soft strokes form a small glow around an actual arrow, no ring.
          for(int i=7;i>=2;i--)using(var glow=new Pen(Color.FromArgb((int)(18*(1-i/9.0)),64,158,255),i*1.5f)){glow.LineJoin=LineJoin.Round;g.DrawPath(glow,arrow);}
          using(var fill=new LinearGradientBrush(new RectangleF(0,0,28,36),Color.FromArgb(255,127,223,255),Color.FromArgb(255,34,109,239),60f))g.FillPath(fill,arrow);
          using(var outline=new Pen(Color.FromArgb(255,14,61,136),1.4f)){outline.LineJoin=LineJoin.Round;g.DrawPath(outline,arrow);}
          using(var highlight=new Pen(Color.FromArgb(220,216,246,255),.9f))g.DrawLines(highlight,new PointF[]{new PointF(1.5f,3),new PointF(2.4f,25),new PointF(8,20)});
        }
        g.Restore(saved);
        float bx=left?x-86:x+32,by=up?y-31:y+18;
        using(var shape=Rounded(new RectangleF(bx,by,54,22),7)) {
          using(var fill=new SolidBrush(Color.FromArgb(244,20,55,91)))g.FillPath(fill,shape);
          using(var outline=new Pen(Color.FromArgb(220,110,195,255),1))g.DrawPath(outline,shape);
        }
        using(var font=new Font("Segoe UI",9,FontStyle.Bold,GraphicsUnit.Pixel))
        using(var brush=new SolidBrush(Color.FromArgb(255,237,247,255)))
        using(var format=new StringFormat {Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center})g.DrawString("DSH",font,brush,new RectangleF(bx,by,54,22),format);
      }
      return image;
    }
  }

  // Only narrow edge tiles are rendered/uploaded per frame. A 4K screen does
  // not allocate and upload a full transparent 33 MB desktop bitmap every tick.
  internal sealed class AuroraField {
    readonly int width,height,depth;readonly Color[] colors;readonly int[] opacity;
    static readonly Color[] Palette={Color.FromArgb(77,230,181),Color.FromArgb(65,211,235),Color.FromArgb(81,151,255),Color.FromArgb(167,130,255),Color.FromArgb(85,208,239),Color.FromArgb(77,230,181)};
    internal AuroraField(int w,int h,int d,double seconds) {
      width=w;height=h;depth=d;int perimeter=2*(w+h);colors=new Color[perimeter];opacity=new int[d];
      for(int i=0;i<perimeter;i++) {
        double t=(i/(double)perimeter-seconds/16.0)%1;if(t<0)t++;
        double p=t*(Palette.Length-1);int index=(int)p;double blend=p-index;blend=blend*blend*(3-2*blend);
        Color a=Palette[index],b=Palette[index+1];
        colors[i]=Color.FromArgb((int)(a.R+(b.R-a.R)*blend),(int)(a.G+(b.G-a.G)*blend),(int)(a.B+(b.B-a.B)*blend));
      }
      // A wider, slower fade remains visible on light apps and larger displays.
      for(int i=0;i<d;i++)opacity[i]=(int)(176*Math.Pow(1-i/(double)d,2.1));
    }
    internal static Rectangle[] Tiles(int w,int h,int d) {return new Rectangle[]{new Rectangle(0,0,w,d),new Rectangle(0,h-d,w,d),new Rectangle(0,d,d,h-2*d),new Rectangle(w-d,d,d,h-2*d)};}
    internal Bitmap Draw(Rectangle tile) {
      var image=new Bitmap(tile.Width,tile.Height,PixelFormat.Format32bppPArgb);var pixels=new int[tile.Width*tile.Height];
      for(int y=0;y<tile.Height;y++)for(int x=0;x<tile.Width;x++) {
        int gx=x+tile.X,gy=y+tile.Y,d=gy,p=gx;
        if(width-1-gx<d){d=width-1-gx;p=width+gy;}
        if(height-1-gy<d){d=height-1-gy;p=width+height+(width-1-gx);}
        if(gx<d){d=gx;p=2*width+height+(height-1-gy);}
        if(d>=depth)continue;int alpha=opacity[d];Color c=colors[p];
        pixels[y*tile.Width+x]=(alpha<<24)|((c.R*alpha/255)<<16)|((c.G*alpha/255)<<8)|(c.B*alpha/255);
      }
      var data=image.LockBits(new Rectangle(0,0,image.Width,image.Height),ImageLockMode.WriteOnly,PixelFormat.Format32bppPArgb);
      try {for(int y=0;y<image.Height;y++)Marshal.Copy(pixels,y*image.Width,IntPtr.Add(data.Scan0,y*data.Stride),image.Width);}
      finally {image.UnlockBits(data);}return image;
    }
  }

  internal class OverlayLayer : Form {
    IntPtr dc,bitmap,previous;bool remoteVisible,dirty=true;byte lastAlpha;
    internal OverlayLayer(Rectangle bounds,bool visible) {
      remoteVisible=visible;AutoScaleMode=AutoScaleMode.None;FormBorderStyle=FormBorderStyle.None;
      ShowInTaskbar=false;TopMost=true;StartPosition=FormStartPosition.Manual;Bounds=bounds;dc=Native.CreateCompatibleDC(IntPtr.Zero);
    }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get {var value=base.CreateParams;value.ExStyle|=0x80000|0x20|0x80|0x08000000;return value;}}
    protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);SetRemoteVisible(remoteVisible);}
    internal virtual void SetRemoteVisible(bool visible){remoteVisible=visible;if(IsHandleCreated)Native.SetWindowDisplayAffinity(Handle,visible?0u:0x11u);}
    internal virtual bool ClickThrough {get{return (Native.GetWindowLong(Handle,-20)&0x08080020)==0x08080020;}}
    internal virtual bool CaptureExcluded {get{uint affinity;return Native.GetWindowDisplayAffinity(Handle,out affinity)&&affinity==0x11;}}
    internal void SetImage(Bitmap image) {
      IntPtr next=image.GetHbitmap(Color.FromArgb(0)),selected=Native.SelectObject(dc,next);
      if(bitmap==IntPtr.Zero)previous=selected;else Native.DeleteObject(bitmap);bitmap=next;dirty=true;
    }
    internal virtual void Present(byte alpha) {
      if(IsDisposed||bitmap==IntPtr.Zero||(!dirty&&alpha==lastAlpha))return;
      var destination=new Native.Point(Left,Top);var origin=new Native.Point(0,0);var size=new Native.Size(Width,Height);
      var blend=new Native.Blend{op=0,flags=0,alpha=alpha,format=1};
      if(!Native.UpdateLayeredWindow(Handle,IntPtr.Zero,ref destination,ref size,dc,ref origin,0,ref blend,2))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not present aurora indicator");
      dirty=false;lastAlpha=alpha;
    }
    protected override void Dispose(bool disposing){if(dc!=IntPtr.Zero){if(bitmap!=IntPtr.Zero){Native.SelectObject(dc,previous);Native.DeleteObject(bitmap);}Native.DeleteDC(dc);dc=IntPtr.Zero;}base.Dispose(disposing);}
  }

  internal sealed class Frame : OverlayLayer {
    readonly Rectangle rectangle;readonly OverlayLayer[] edges;readonly Rectangle[] tiles;readonly int depth;
    double renderedAt=Double.NegativeInfinity;
    internal Frame(Rectangle bounds,string text,string position,bool visible):base(new Rectangle(bounds.Left,bounds.Top,1,1),visible) {
      rectangle=bounds;
      uint dpiX=96,dpiY=96;try {if(Native.GetDpiForMonitor(Native.MonitorFromPoint(new Native.Point(bounds.Left,bounds.Top),2),0,out dpiX,out dpiY)!=0)dpiX=96;}catch(EntryPointNotFoundException){}
      depth=OverlayVisuals.EdgeDepth(bounds.Width,bounds.Height,dpiX);
      tiles=AuroraField.Tiles(bounds.Width,bounds.Height,depth);edges=new OverlayLayer[tiles.Length];
      for(int i=0;i<tiles.Length;i++){var r=tiles[i];r.Offset(bounds.Location);edges[i]=new OverlayLayer(r,visible);}
      using(var badge=OverlayVisuals.Badge(bounds.Width,text)) {
        int gap=(int)(22*OverlayVisuals.BadgeScale(bounds.Width));
        Bounds=new Rectangle(bounds.Left+(bounds.Width-badge.Width)/2,position=="bottom"?bounds.Bottom-badge.Height-gap:bounds.Top+gap,badge.Width,badge.Height);SetImage(badge);
      }
    }
    protected override void OnShown(EventArgs e){base.OnShown(e);foreach(var edge in edges)edge.Show();}
    internal Rectangle DisplayBounds {get{return rectangle;}}
    internal override void SetRemoteVisible(bool visible){base.SetRemoteVisible(visible);if(edges!=null)foreach(var edge in edges)edge.SetRemoteVisible(visible);}
    internal override bool ClickThrough {get{return base.ClickThrough&&Array.TrueForAll(edges,e=>e.ClickThrough);}}
    internal override bool CaptureExcluded {get{return base.CaptureExcluded&&Array.TrueForAll(edges,e=>e.CaptureExcluded);}}
    internal override void Present(byte alpha) {
      if(IsDisposed)return;double now=OverlayVisuals.Clock.Elapsed.TotalSeconds;
      // 16 fps is enough for slow aurora flow; the 35 ms host stop timer stays intact.
      if(now-renderedAt>=1.0/16) {
        var field=new AuroraField(rectangle.Width,rectangle.Height,depth,now);
        for(int i=0;i<edges.Length;i++)using(var image=field.Draw(tiles[i]))edges[i].SetImage(image);
        renderedAt=now;
      }
      foreach(var edge in edges){Native.KeepOnTop(edge.Handle);edge.Present(alpha);}Native.KeepOnTop(Handle);base.Present(alpha);
    }
    internal static Bitmap Draw(int width,int height,string text,string position){return OverlayVisuals.DrawFrame(width,height,text,position,0);}
    protected override void Dispose(bool disposing){if(disposing&&edges!=null)foreach(var edge in edges)edge.Dispose();base.Dispose(disposing);}
  }
}
