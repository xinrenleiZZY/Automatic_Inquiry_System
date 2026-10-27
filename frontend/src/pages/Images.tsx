import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Image, Popconfirm, Row, Select, Space, Tag, Typography, Upload, message } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, SyncOutlined, ToolOutlined, UploadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { del, detailOf, get, post } from '../api/client';
import type { LibraryImage, Phrase } from '../api/types';
import { bytes } from '../utils/format';

const imgUrl = (p: string) => `/api/library/file?path=${encodeURIComponent(p)}`;

export default function Images() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const data = useQuery({
    queryKey: ['library-images'],
    queryFn: () => get<{ dir: string; items: LibraryImage[]; total: number; phrases: Phrase[] }>('/api/library/images')
  });

  useEffect(() => {
    const h = () => void qc.invalidateQueries();
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['library-images'] });
    void qc.invalidateQueries({ queryKey: ['phrases'] });
  };

  const sync = async () => {
    setBusy(true);
    try {
      const r = await post<{ total: number; added: number }>('/api/library/images/sync');
      message.success(`已同步：共 ${r.total} 张，新增 ${r.added} 张`);
      refresh();
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/library/images/upload', { method: 'POST', body: fd, credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`);
      message.success(`已上传 ${file.name}`);
      refresh();
    } catch (e) {
      message.error(detailOf(e));
    }
    return false;
  };

  const bind = async (path: string, phraseId?: string) => {
    try {
      const r = await post<{ phraseId: string | null; cleared?: boolean }>('/api/library/images/bind', {
        image_path: path,
        phrase_id: phraseId || null
      });
      message.success(r?.cleared ? '已清除绑定' : `已绑定：${r?.phraseId || ''}`);
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      // 成功失败都刷新，避免界面和库里不一致
      refresh();
    }
  };

  const repair = async () => {
    setBusy(true);
    try {
      const r = await post<{ removed_junk: number; fixed: number; missing_files: string[]; total_in_db: number }>(
        '/api/library/images/repair'
      );
      message.success(
        `体检完成：清理幽灵行 ${r.removed_junk} 条 · 修复文件信息 ${r.fixed} 条 · 磁盘缺失 ${r.missing_files.length} 张 · 库内共 ${r.total_in_db} 条`
      );
      refresh();
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (path: string) => {
    try {
      await del('/api/library/images', { path });
      message.success('已删除图片文件');
      refresh();
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const phrases = data.data?.phrases || [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="图片库 = 一个本地文件夹"
        description={
          <span>
            直接把图片丢进目录、或在这里上传即可；点「同步」把新图片登记进库。每张图可以绑定一条快捷短语，
            任务启动时默认用绑定短语的图（也可在任务里单独覆盖）。当前目录：
            <Typography.Text code copyable style={{ marginLeft: 6 }}>
              {data.data?.dir || '-'}
            </Typography.Text>
          </span>
        }
      />

      <Card
        title={`图片库（${data.data?.total ?? 0}）`}
        extra={
          <Space>
            <Button icon={<FolderOpenOutlined />} onClick={() => void navigator.clipboard?.writeText(data.data?.dir || '')}>
              复制目录路径
            </Button>
            <Button icon={<SyncOutlined />} loading={busy} onClick={sync}>
              同步文件夹
            </Button>
            <Button icon={<ToolOutlined />} loading={busy} onClick={repair}>
              修复图片库
            </Button>
            <Upload beforeUpload={upload} showUploadList={false} accept="image/*">
              <Button type="primary" icon={<UploadOutlined />}>
                上传图片
              </Button>
            </Upload>
          </Space>
        }
      >
        {data.data?.items?.length ? (
          <Row gutter={[16, 16]}>
            {data.data.items.map((img) => (
              <Col xs={24} sm={12} lg={8} xl={6} key={img.path}>
                <div className="ais-img-card">
                  <div className="ais-img-thumb">
                    <Image src={imgUrl(img.path)} alt={img.fileName} preview={{ mask: '预览' }} style={{ maxHeight: '100%' }} />
                  </div>
                  <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                    <Space direction="vertical" size={2}>
                      <Typography.Text strong ellipsis style={{ fontSize: 13 }}>
                        {img.fileName}
                      </Typography.Text>
                      <Typography.Text style={{ fontSize: 11, color: '#98a4b8' }}>
                        {bytes(img.size)} · {img.hash}
                      </Typography.Text>
                    </Space>
                    <Space size={4} wrap>
                      {img.status ? <Tag color={img.status === 'done' ? 'green' : 'blue'}>{img.status}</Tag> : null}
                      {img.image_id ? <Tag>imageId {String(img.image_id).slice(0, 8)}…</Tag> : null}
                    </Space>
                    <Select
                      size="small"
                      allowClear
                      placeholder="绑定快捷短语"
                      value={img.phrase_id || undefined}
                      style={{ width: '100%' }}
                      onChange={(v) => bind(img.path, v)}
                      options={phrases.map((p) => ({ value: p.id, label: p.name }))}
                    />
                    <div style={{ marginTop: 'auto', textAlign: 'right' }}>
                      <Popconfirm title="确认删除这个图片文件？" onConfirm={() => remove(img.path)}>
                        <Button size="small" danger type="text" icon={<DeleteOutlined />}>
                          删除
                        </Button>
                      </Popconfirm>
                    </div>
                  </div>
                </div>
              </Col>
            ))}
          </Row>
        ) : (
          <Empty description="图片库为空，先上传或把图片放进目录后点「同步文件夹」" style={{ padding: 50 }} />
        )}
      </Card>
    </Space>
  );
}
