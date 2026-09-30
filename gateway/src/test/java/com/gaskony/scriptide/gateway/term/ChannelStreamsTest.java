package com.gaskony.scriptide.gateway.term;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * A terminal is duplex: the pump thread sits in {@code read()} waiting for the
 * shell, and keystrokes are written from another thread while it waits. The
 * JDK's {@link Channels#newInputStream} and {@link Channels#newOutputStream}
 * take the channel's {@code blockingLock()} around every call, so a write
 * waits for the parked read — and the read waits for the shell to answer the
 * write that never went. Measured on the gateway 02/09/2026: prompt, then
 * every keystroke swallowed, and the shell leaked because close() hung on its
 * exit sequence.
 *
 * <p>The peer here is the shape of that shell: it says nothing until it is
 * spoken to.</p>
 */
class ChannelStreamsTest {

    /** A peer that echoes only once it has received something. */
    private static SocketChannel[] pair(Thread[] peerOut) throws Exception {
        ServerSocketChannel server = ServerSocketChannel.open();
        server.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
        SocketChannel client = SocketChannel.open(server.getLocalAddress());
        SocketChannel peer = server.accept();
        server.close();
        Thread echo = new Thread(() -> {
            try {
                ByteBuffer buf = ByteBuffer.allocate(64);
                if (peer.read(buf) > 0) {
                    buf.flip();
                    while (buf.hasRemaining()) {
                        peer.write(buf);
                    }
                }
            } catch (Exception ignored) {
                // the test closes the channel under us
            }
        }, "silent-peer");
        echo.setDaemon(true);
        echo.start();
        peerOut[0] = echo;
        return new SocketChannel[] {client, peer};
    }

    private static boolean writeWhileReading(InputStream in, OutputStream out) throws Exception {
        CountDownLatch reading = new CountDownLatch(1);
        Thread pump = new Thread(() -> {
            try {
                reading.countDown();
                in.read(new byte[64]);
            } catch (Exception ignored) {
                // closed under us at the end
            }
        }, "pump");
        pump.setDaemon(true);
        pump.start();
        reading.await(5, TimeUnit.SECONDS);
        Thread.sleep(100); // let the pump park inside read()

        CountDownLatch written = new CountDownLatch(1);
        Thread typist = new Thread(() -> {
            try {
                out.write("x".getBytes(StandardCharsets.UTF_8));
                out.flush();
                written.countDown();
            } catch (Exception ignored) {
                // closed under us at the end
            }
        }, "typist");
        typist.setDaemon(true);
        typist.start();
        return written.await(2, TimeUnit.SECONDS);
    }

    @Test
    @DisplayName("the JDK adapters cannot write while a read is parked — the measured defect")
    void jdkAdaptersSerialiseReadAndWrite() throws Exception {
        Thread[] peer = new Thread[1];
        SocketChannel[] channels = pair(peer);
        try {
            boolean wrote = writeWhileReading(
                Channels.newInputStream(channels[0]), Channels.newOutputStream(channels[0]));
            assertThat(wrote)
                .as("if this ever passes, the JDK changed and the wrappers can go")
                .isFalse();
        } finally {
            channels[0].close();
            channels[1].close();
        }
    }

    @Test
    @DisplayName("the channel wrappers write while a read is parked")
    void wrappersAreDuplex() throws Exception {
        Thread[] peer = new Thread[1];
        SocketChannel[] channels = pair(peer);
        try {
            boolean wrote = writeWhileReading(
                new DockerExec.ChannelInput(channels[0]), new DockerExec.ChannelOutput(channels[0]));
            assertThat(wrote).as("a keystroke must reach the shell while the pump waits").isTrue();
        } finally {
            channels[0].close();
            channels[1].close();
        }
    }
}
