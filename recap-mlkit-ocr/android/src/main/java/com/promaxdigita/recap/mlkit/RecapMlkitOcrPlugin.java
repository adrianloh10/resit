package com.promaxdigita.recap.mlkit;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

/**
 * Minimal on-device receipt OCR for the Recap app.
 *
 * ONE method — recognize(): decode a base64 image, run Google ML Kit Text
 * Recognition v2 (Latin script, unbundled via Google Play services), and hand
 * back the recognised lines with their bounding boxes so the JS side
 * (ocr.js) can reshape them into the same text/line structure the Tesseract
 * parser already eats. All parsing, merchant/date/total logic and the
 * digit-sniper cross-validation stay in JS — this plugin does nothing but read
 * pixels into text + geometry.
 *
 * Result shape (JSON):
 *   {
 *     "width":  <source image px width>,
 *     "height": <source image px height>,
 *     "lines": [
 *       {
 *         "text": "TOTAL 23.50",
 *         "frame": { "left":.., "top":.., "right":.., "bottom":.. },
 *         "confidence": 0.93,            // omitted when ML Kit reports none
 *         "elements": [                  // word-level boxes for the sniper crop
 *           { "text": "TOTAL", "frame": { "left":.., "top":.., "right":.., "bottom":.. } },
 *           { "text": "23.50", "frame": { "left":.., "top":.., "right":.., "bottom":.. } }
 *         ]
 *       }
 *     ]
 *   }
 */
@CapacitorPlugin(name = "RecapMlkitOcr")
public class RecapMlkitOcrPlugin extends Plugin {

    @PluginMethod
    public void recognize(PluginCall call) {
        String image = call.getString("image");
        if (image == null || image.isEmpty()) {
            call.reject("Missing 'image' (base64) parameter");
            return;
        }
        // Accept an optional data-URL prefix ("data:image/jpeg;base64,....").
        if (image.startsWith("data:")) {
            int comma = image.indexOf(',');
            if (comma >= 0) {
                image = image.substring(comma + 1);
            }
        }

        Bitmap bitmap;
        try {
            byte[] bytes = Base64.decode(image, Base64.DEFAULT);
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            call.reject("Could not decode base64 image", e);
            return;
        }
        if (bitmap == null) {
            call.reject("Could not decode image bytes into a bitmap");
            return;
        }

        final Bitmap bmp = bitmap;
        final TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        InputImage input = InputImage.fromBitmap(bmp, 0);
        recognizer
            .process(input)
            .addOnSuccessListener(result -> {
                JSObject ret = new JSObject();
                ret.put("width", bmp.getWidth());
                ret.put("height", bmp.getHeight());
                JSArray lines = new JSArray();
                for (Text.TextBlock block : result.getTextBlocks()) {
                    for (Text.Line line : block.getLines()) {
                        lines.put(lineToJson(line));
                    }
                }
                ret.put("lines", lines);
                recognizer.close();
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                recognizer.close();
                call.reject("ML Kit text recognition failed: " + e.getMessage(), e);
            });
    }

    private JSObject lineToJson(Text.Line line) {
        JSObject lo = new JSObject();
        lo.put("text", line.getText());
        lo.put("frame", rectToJson(line.getBoundingBox()));
        Float conf = line.getConfidence();
        if (conf != null && !conf.isNaN() && !conf.isInfinite()) {
            lo.put("confidence", conf.doubleValue());
        }
        JSArray elements = new JSArray();
        for (Text.Element el : line.getElements()) {
            JSObject eo = new JSObject();
            eo.put("text", el.getText());
            eo.put("frame", rectToJson(el.getBoundingBox()));
            elements.put(eo);
        }
        lo.put("elements", elements);
        return lo;
    }

    private JSObject rectToJson(Rect r) {
        JSObject f = new JSObject();
        if (r != null) {
            f.put("left", r.left);
            f.put("top", r.top);
            f.put("right", r.right);
            f.put("bottom", r.bottom);
        }
        return f;
    }
}
