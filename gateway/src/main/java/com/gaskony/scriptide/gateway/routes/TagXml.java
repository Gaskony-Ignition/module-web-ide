package com.gaskony.scriptide.gateway.routes;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import java.io.ByteArrayInputStream;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * Tag XML helpers. The platform's importer picks its decoder by one thing: a
 * {@code MinVersion="..."} attribute. With it the document is the 8.x export
 * (nested {@code <Tags>}, imported under the base path as the Designer does);
 * without it the document is the pre-8 flat format, where every {@code <Tag>}
 * names its parent with a {@code path} attribute counted from the PROVIDER root
 * and the platform ignores the base path.
 */
final class TagXml {

    private static final Pattern MIN_VERSION = Pattern.compile("MinVersion=\"(.*?)\"");

    private TagXml() {
    }

    /** True for the 8.x export, which the platform imports faithfully as it stands. */
    static boolean isCurrentFormat(String xml) {
        return xml != null && MIN_VERSION.matcher(xml).find();
    }

    /**
     * Moves a pre-8 flat document under {@code basePath} (a provider-relative
     * path, empty for the provider root) by prefixing every {@code path}
     * attribute. Tags with no attribute are children nested inside a parent tag
     * and move with it.
     */
    static String rebaseLegacy(String xml, String basePath) throws Exception {
        if (basePath == null || basePath.isEmpty()) {
            return xml;
        }
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        // Imported files are untrusted: no DTDs, so no entity expansion or external fetches.
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        Document doc = factory.newDocumentBuilder()
            .parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
        NodeList tags = doc.getElementsByTagName("Tag");
        for (int i = 0; i < tags.getLength(); i++) {
            Element tag = (Element) tags.item(i);
            if (tag.hasAttribute("path")) {
                String own = tag.getAttribute("path");
                tag.setAttribute("path", own.isEmpty() ? basePath : basePath + "/" + own);
            }
        }
        // The platform builds the folders above a tag from the document alone; with
        // none naming the base path's own segments it fails ("name is null"), so the
        // base's ancestors travel with the document as explicit folders.
        Element root = doc.getDocumentElement();
        org.w3c.dom.Node first = root.getFirstChild();
        int end = 0;
        while (end < basePath.length()) {
            int slash = basePath.indexOf('/', end);
            int stop = slash < 0 ? basePath.length() : slash;
            Element folder = doc.createElement("Tag");
            folder.setAttribute("name", basePath.substring(end, stop));
            folder.setAttribute("type", "Folder");
            folder.setAttribute("path", end == 0 ? "" : basePath.substring(0, end - 1));
            root.insertBefore(folder, first);
            end = stop + 1;
        }
        TransformerFactory tf = TransformerFactory.newInstance();
        tf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        javax.xml.transform.Transformer transformer = tf.newTransformer();
        transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
        StringWriter out = new StringWriter();
        transformer.transform(new DOMSource(doc), new StreamResult(out));
        return out.toString();
    }
}
